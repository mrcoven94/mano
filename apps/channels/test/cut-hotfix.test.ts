import { describe, expect, it } from "vitest";
import { CRISIS_LINE } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch } from "./helpers.js";

async function sendsFor(text: string): Promise<string[]> {
  const h = makeHarness({ replies: ["that's a lot to get hit with. can you send a photo of the letter?"] });
  await h.runner.handleEvent(inboundEvent({ id: "evt_1", text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.map((s) => s.text);
}

describe("a benefits cut is not self-harm, through the runner", () => {
  it("sends no crisis line for a cut to food stamps or hours", async () => {
    for (const text of ["they cut my food stamps. i have 2 kids", "they're cutting my hours"]) {
      expect(await sendsFor(text), text).not.toContain(CRISIS_LINE);
    }
  });

  it("still sends the crisis line for cutting oneself", async () => {
    for (const text of ["I cut my wrists", "I've been cutting myself", "I keep cutting my forearms", "I cut my stomach again", "I've been cutting again to punish myself"]) {
      expect(await sendsFor(text), text).toContain(CRISIS_LINE);
    }
  });
});
