import { describe, expect, it } from "vitest";
import { PROBES, REACTION_PROBES, allowedTapback, checkProbe, checkReactionSet, crisisLineFor, crisisTurn, guardReply, holdCrisisLines, mightBeCrisis, type GuardChange, type ProbeRun, type ReactionRun } from "@mano/persona";
import { splitBubbles } from "../src/bubbles.js";
import { SparkResponder } from "../src/responder.js";

const apiKey = process.env.META_MODEL_API_KEY ?? "";
const model = process.env.MANO_PROBE_MODEL ?? "";

if (!apiKey) console.log("probe:live skipped: META_MODEL_API_KEY is not set.");

describe.skipIf(!apiKey)("persona probes, live", () => {
  it("holds Mano's voice on every probe through the real responder", async () => {
    expect(model.endsWith("-contributor"), "probes send synthetic text to a -contributor model ID only").toBe(true);
    const responder = new SparkResponder({
      apiKey,
      model,
      baseUrl: process.env.MANO_MODEL_BASE_URL || undefined,
    });
    const rows: string[] = [];
    let failures = 0;
    for (const probe of PROBES) {
      const started = performance.now();
      const heard: { at: number; text: string }[] = [];
      let raw: string;
      let chosen: ReturnType<typeof allowedTapback> = null;
      try {
        const result = await responder.respond(
          { texts: [probe.text], attachmentCount: 0, history: probe.history },
          { onHeadsUp: async (text) => void heard.push({ at: performance.now(), text }) },
        );
        raw = result.text;
        chosen = result.tapback ?? null;
      } catch (err) {
        failures += 1;
        rows.push(`FAIL ${probe.id}: responder error ${(err as Error).name}`);
        continue;
      }
      const totalMs = performance.now() - started;
      const modelIds = [model];
      // Mirrors the runner: the tapback rules, and a tapback alone is a reply.
      const tapback = allowedTapback(chosen, probe.text, mightBeCrisis(probe.text));
      const guarded = raw.trim().length === 0 && chosen ? { text: "", changes: [] as GuardChange[] } : guardReply(raw, { modelIds });
      // Mirrors finalizeReply on a crisis turn: the crisis line in the
      // person's language goes first, once, and the model writes the rest.
      const reply = crisisTurn(probe.text)
        ? { text: holdCrisisLines(splitBubbles(guarded.text), crisisLineFor(probe.text)).join("\n"), changes: guarded.changes }
        : guarded;
      const headsUp = heard[0] ? guardReply(heard[0].text, { modelIds }) : null;
      const changes: GuardChange[] = [...(headsUp?.changes ?? []), ...reply.changes];
      const run: ProbeRun = {
        path: heard[0] ? "deep" : "fast",
        reply: reply.text,
        headsUp: headsUp?.text ?? null,
        firstTextMs: heard[0] ? heard[0].at - started : totalMs,
        tapback,
      };
      const failed = checkProbe(probe, run, { modelIds });
      if (failed.length > 0) failures += 1;
      rows.push(
        [
          `${failed.length === 0 ? "PASS" : "FAIL"} ${probe.id} (${run.path}, first text ${(run.firstTextMs / 1000).toFixed(1)} s, total ${(totalMs / 1000).toFixed(1)} s)`,
          `  person: ${probe.text}`,
          ...(run.headsUp === null ? [] : [`  heads-up: ${run.headsUp}`]),
          ...(run.tapback ? [`  tapback: ${run.tapback}`] : []),
          `  mano: ${run.reply.replace(/\n/g, " / ")}`,
          `  guard: ${changes.length === 0 ? "nothing to fix" : changes.join(", ")}`,
          ...(failed.length === 0 ? [] : [`  failed: ${failed.join(", ")}`]),
        ].join("\n"),
      );
    }
    console.log(`model ${model}, ${PROBES.length} probes, ${PROBES.length - failures} passed\n\n${rows.join("\n\n")}`);
    expect(failures).toBe(0);
  });

  it("reacts sparingly, with variety, and only where it fits, across 20 messages", async () => {
    expect(model.endsWith("-contributor"), "probes send synthetic text to a -contributor model ID only").toBe(true);
    const responder = new SparkResponder({ apiKey, model, baseUrl: process.env.MANO_MODEL_BASE_URL || undefined });
    const runs: ReactionRun[] = [];
    const rows: string[] = [];
    let overruled = 0;
    for (const probe of REACTION_PROBES) {
      try {
        const result = await responder.respond({ texts: [probe.text], attachmentCount: 0 });
        // Code decides which reactions a message allows (PR 74 review 4),
        // so the check grades what would be sent. Where the model picked
        // outside the set, the row shows it and the run counts it.
        const sent = allowedTapback(result.tapback ?? null, probe.text, mightBeCrisis(probe.text));
        if (sent !== (result.tapback ?? null)) overruled += 1;
        runs.push({ id: probe.id, tapback: sent, reply: result.text });
        rows.push(`${probe.id} (${probe.kind}): ${result.tapback ?? "none"}${sent !== (result.tapback ?? null) ? ` (rules: ${sent ?? "none"})` : ""} / ${result.text.replace(/\n/g, " / ").slice(0, 90)}`);
      } catch (err) {
        runs.push({ id: probe.id, tapback: null, reply: "" });
        rows.push(`${probe.id}: responder error ${(err as Error).name}`);
      }
    }
    const failed = checkReactionSet(runs);
    const reacted = runs.filter((r) => r.tapback);
    console.log(
      `reactions sent: ${reacted.length}/${runs.length} messages, distinct ${new Set(reacted.map((r) => r.tapback)).size}, model picks overruled by code: ${overruled}` +
        `${failed.length ? `, failed: ${failed.join(", ")}` : ", all checks pass"}\n${rows.join("\n")}`,
    );
    expect(failed).toEqual([]);
  });
});
