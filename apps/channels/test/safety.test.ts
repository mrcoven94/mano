import { describe, expect, it } from "vitest";
import { HANDLE_HOURLY_LIMIT, hourKeyFor, type Responder } from "@mano/channels";
import { CRISIS_LINE } from "@mano/persona";
import { BUSY_BUBBLE, FAILURE_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch } from "./helpers.js";

// A disclosure no detector is promised to catch: the safety net must
// not depend on detection.
const UNDETECTED = "things at home got really bad tonight";

const names988And911 = (text: string) => /\b988\b/.test(text) && /\b911\b/.test(text);

describe("every busy, over-limit and failure reply names 988 and 911 (review round 3, blocker 1)", () => {
  it("in the fixed texts themselves", () => {
    expect(names988And911(BUSY_BUBBLE)).toBe(true);
    expect(names988And911(FAILURE_BUBBLE)).toBe(true);
  });

  it("when the model fails", async () => {
    const broken: Responder = {
      name: "broken",
      maxAttempts: 1,
      respond: async () => {
        throw new Error("provider down");
      },
    };
    const h = makeHarness({ responder: broken });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: UNDETECTED, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(names988And911(h.channel.sends[h.channel.sends.length - 1].text)).toBe(true);
  });

  it("when the budget denies the turn", async () => {
    const h = makeHarness({ budgetUsd: 0 });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "can you look at my letter", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(h.channel.sends.map((s) => s.text)).toEqual([BUSY_BUBBLE]);
    expect(names988And911(h.channel.sends[0].text)).toBe(true);
  });

  it("when the person is over the hourly limit", async () => {
    const h = makeHarness();
    const meta = h.store.meta();
    meta.introduced = true;
    meta.hourKey = hourKeyFor(h.now);
    meta.hourCount = HANDLE_HOURLY_LIMIT;
    h.store.saveMeta(meta);
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: UNDETECTED, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(names988And911(h.channel.sends.map((s) => s.text).join(" "))).toBe(true);
  });
});

describe("a crisis text gets 988 and 911 before any model answers (PR 102 review, blocker)", () => {
  it("sends the crisis line while the model is still working, then the model's words, with the line once", async () => {
    let asked!: () => void;
    const modelAsked = new Promise<void>((resolve) => (asked = resolve));
    let answer!: (text: string) => void;
    const slow: Responder = {
      name: "slow",
      maxAttempts: 1,
      respond: () => {
        asked();
        return new Promise((resolve) => {
          answer = (text) => resolve({ text, bubbles: [text], inputChars: 1, outputChars: text.length, model: "slow", attempts: 1 });
        });
      },
    };
    const h = makeHarness({ responder: slow });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "I want to end my life", occurredAtMs: h.now }), "webhook");
    const turn = runTurnAfterBatch(h);
    await modelAsked;
    expect(h.channel.sends.map((s) => s.text)).toEqual([CRISIS_LINE]);
    answer("I'm here with you. What is happening tonight?");
    await turn;
    expect(h.channel.sends.map((s) => s.text)).toEqual([CRISIS_LINE, "I'm here with you. What is happening tonight?"]);
  });
});
