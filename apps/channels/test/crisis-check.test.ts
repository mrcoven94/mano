// The crisis decision in the worker (Sol's third review of PR 77): the
// keyword floor, and for one short health question a model check where
// only an exact "no" exempts. Without a check the worker fails closed.
import { describe, expect, it } from "vitest";
import type { CrisisCheck } from "@mano/persona";
import { CRISIS_LINE } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

const check = (answer: string): CrisisCheck & { asked: string[] } => {
  const c = { live: true, asked: [] as string[], ask: async (text: string) => (c.asked.push(text), answer) };
  return c;
};

const QUESTION = "Should I stop taking my blood pressure pills?";

describe("the worker's crisis decision", () => {
  it("answers a health question without the crisis line when the check says no", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["don't stop them on your own. a doctor or pharmacist can tell you"], crisisCheck: c });
    h.store.patchMeta({ introduced: true });
    const sent = await say(h, "evt_1", QUESTION);
    expect(sent).toEqual(["don't stop them on your own. a doctor or pharmacist can tell you"]);
    expect(c.asked).toEqual([QUESTION]);
    // Only the decision and its time are logged, never the message.
    const logged = h.lines.filter((l) => l.includes("crisis_check"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain("blood pressure");
  });

  it("sends the crisis line when the check says yes, says anything else, or is missing", async () => {
    for (const c of [check("yes"), check("No."), null]) {
      const h = makeHarness({ replies: ["a doctor can tell you"], crisisCheck: c });
      h.store.patchMeta({ introduced: true });
      expect((await say(h, "evt_1", QUESTION))[0]).toBe(CRISIS_LINE);
    }
  });

  it("never asks the model about a message that is not one short health question", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["I'm here."], crisisCheck: c });
    h.store.patchMeta({ introduced: true });
    expect((await say(h, "evt_1", "I want to hurt myself tonight."))[0]).toBe(CRISIS_LINE);
    expect(c.asked).toEqual([]);
  });
});

describe("the worker builds the check only on a Standard model with a key", () => {
  it("fails closed without a key or with a -contributor ID", async () => {
    const { buildCrisisCheck } = await import("../src/conversation.js");
    expect(buildCrisisCheck({ MANO_REPLY_MODEL: "muse-spark-1.3" } as never)).toBeNull();
    expect(buildCrisisCheck({ META_MODEL_API_KEY: "test-key-not-real", MANO_REPLY_MODEL: "muse-spark-1.3-contributor" } as never)).toBeNull();
    expect(buildCrisisCheck({ META_MODEL_API_KEY: "test-key-not-real", MANO_REPLY_MODEL: "muse-spark-1.3" } as never)?.live).toBe(true);
  });
});
