import { describe, expect, it } from "vitest";
import { SELF_DESCRIPTION } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

describe("PR 67 round 5, guard, through the runner", () => {
  it("treats underscores as separators for stack names and model IDs (3)", async () => {
    const h = makeHarness({ replies: ["I'm Mano, powered by Meta_AI. Bring the letter."] });
    expect((await say(h, "evt_1", "who made you")).slice(1)).toEqual([`${SELF_DESCRIPTION} Bring the letter.`]);
    const h2 = makeHarness({ replies: ["Answers come from _muse_spark_1.3_ here. Bring the letter."] });
    const sent = (await say(h2, "evt_1", "who made you")).slice(1).join(" ");
    expect(sent).not.toMatch(/muse|spark/i);
  });
  it("protects quoted text across sentences (4)", async () => {
    for (const reply of [
      "On line 3, write 'My name is Maria Garcia. I am the applicant.' and sign.",
      "Type “I'm Robin. I live at 12 Oak St.” in box 2.",
      'Write "My name is Maria. I\'m 34." on page 1.',
    ]) {
      const h = makeHarness({ replies: [reply] });
      expect((await say(h, "evt_1", "what do i write")).slice(1), reply).toEqual([reply]);
    }
  });
});
