import { describe, expect, it } from "vitest";
import { PROBES, checkProbe, guardReply, type GuardChange, type ProbeRun } from "@mano/persona";
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
      try {
        const result = await responder.respond(
          { texts: [probe.text], attachmentCount: 0 },
          { onHeadsUp: async (text) => void heard.push({ at: performance.now(), text }) },
        );
        raw = result.text;
      } catch (err) {
        failures += 1;
        rows.push(`FAIL ${probe.id}: responder error ${(err as Error).name}`);
        continue;
      }
      const totalMs = performance.now() - started;
      const reply = guardReply(raw);
      const headsUp = heard[0] ? guardReply(heard[0].text) : null;
      const changes: GuardChange[] = [...(headsUp?.changes ?? []), ...reply.changes];
      const run: ProbeRun = {
        path: heard[0] ? "deep" : "fast",
        reply: reply.text,
        headsUp: headsUp?.text ?? null,
        firstTextMs: heard[0] ? heard[0].at - started : totalMs,
      };
      const failed = checkProbe(probe, run);
      if (failed.length > 0) failures += 1;
      rows.push(
        [
          `${failed.length === 0 ? "PASS" : "FAIL"} ${probe.id} (${run.path}, first text ${(run.firstTextMs / 1000).toFixed(1)} s, total ${(totalMs / 1000).toFixed(1)} s)`,
          `  person: ${probe.text}`,
          ...(run.headsUp === null ? [] : [`  heads-up: ${run.headsUp}`]),
          `  mano: ${run.reply.replace(/\n/g, " / ")}`,
          `  guard: ${changes.length === 0 ? "nothing to fix" : changes.join(", ")}`,
          ...(failed.length === 0 ? [] : [`  failed: ${failed.join(", ")}`]),
        ].join("\n"),
      );
    }
    console.log(`model ${model}, ${PROBES.length} probes, ${PROBES.length - failures} passed\n\n${rows.join("\n\n")}`);
    expect(failures).toBe(0);
  });
});
