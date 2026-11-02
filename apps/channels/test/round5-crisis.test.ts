import { describe, expect, it } from "vitest";
import { TURN_TEXT_CAP } from "@mano/channels";
import { CRISIS_LINE } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

describe("PR 67 round 5, crisis, through the runner", () => {
  it("checks the whole message for a crisis, not the buffer pieces it was split into (1)", async () => {
    const filler = "please help me with my renewal form ";
    const prefix = `${filler.repeat(Math.ceil(TURN_TEXT_CAP / filler.length)).slice(0, TURN_TEXT_CAP - 4)} `;
    const text = `${prefix}suicide is on my mind tonight`;
    expect(text.slice(0, TURN_TEXT_CAP).endsWith("sui")).toBe(true);
    const h = makeHarness({ replies: ["Can you tell me more?", "Can you tell me more?"] });
    const sent = await say(h, "evt_long", text);
    expect(sent).toContain(CRISIS_LINE);
  });
  it("runs an approval reply through the crisis check, sends the crisis line first and still records the decision (2)", async () => {
    const h = makeHarness();
    await h.runner.requestApproval({ id: "apr_1", code: "kill-me", summary: "Synthetic test approval.", ttlMs: 3600_000 });
    const sent = await say(h, "evt_yes", "YES kill-me");
    expect(sent[0] === CRISIS_LINE || sent[1] === CRISIS_LINE).toBe(true);
    expect(sent.indexOf(CRISIS_LINE)).toBeLessThan(sent.length - 1);
    expect(h.store.pendingApprovals(h.now)).toHaveLength(0);
  });
});
