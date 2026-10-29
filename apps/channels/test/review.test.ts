import { describe, expect, it } from "vitest";
import { HANDLE_HOURLY_LIMIT, ResponderFailed, hourKeyFor, type Responder } from "@mano/channels";
import { CRISIS_LINE } from "@mano/persona";
import { BUSY_BUBBLE, FAILURE_BUBBLE, INTRO_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

const CRISIS_TEXT = "I want to die";

function sent(h: Harness): string[] {
  return h.channel.sends.map((s) => s.text);
}

function failing(err: Error): Responder {
  return {
    name: "failing",
    maxAttempts: 3,
    respond: async () => {
      throw err;
    },
  };
}

describe("crisis protection does not depend on the model (review blocker 1)", () => {
  it("sends the crisis line when the model times out or errors", async () => {
    for (const err of [new ResponderFailed("timeout", 3, 1000), new Error("provider down")]) {
      const h = makeHarness({ responder: failing(err) });
      await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: CRISIS_TEXT, occurredAtMs: h.now }), "webhook");
      await runTurnAfterBatch(h);
      expect(sent(h)).toEqual([INTRO_BUBBLE, CRISIS_LINE]);
      expect(sent(h)).not.toContain(FAILURE_BUBBLE);
    }
  });

  it("sends the crisis line when the budget denies the turn, without calling the model", async () => {
    const h = makeHarness({ budgetUsd: 0, responder: failing(new Error("must not be called")) });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: CRISIS_TEXT, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sent(h)).toContain(CRISIS_LINE);
    expect(sent(h)).not.toContain(BUSY_BUBBLE);
  });

  it("sends the crisis line past the per-person hourly limit", async () => {
    const h = makeHarness();
    const meta = h.store.meta();
    meta.introduced = true;
    meta.hourKey = hourKeyFor(h.now);
    meta.hourCount = HANDLE_HOURLY_LIMIT;
    h.store.saveMeta(meta);
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: CRISIS_TEXT, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sent(h)).toEqual([CRISIS_LINE]);
  });
});

describe("the final bubbles of a crisis turn always name 988 and 911 (review blocker 2)", () => {
  it("restores the numbers when the guard drops the sentence that held them", async () => {
    const h = makeHarness({ replies: ["Call 988 or 911 through Meta."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: CRISIS_TEXT, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answer = sent(h).slice(1).join(" ");
    expect(answer).toContain("988");
    expect(answer).toContain("911");
    expect(answer).not.toContain("Meta");
  });

  it("restores the numbers when bubble truncation drops them", async () => {
    const long = Array.from({ length: 6 }, (_, i) => `${"I'm here with you and I'm not going anywhere ".repeat(12).trim()} ${i}.`).join(" ");
    const h = makeHarness({ replies: [`${long} Call 988 or 911.`] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: CRISIS_TEXT, occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    const answer = sent(h).slice(1);
    expect(answer[0]).toBe(CRISIS_LINE);
    expect(answer.length).toBeLessThanOrEqual(4);
  });
});

describe("deep heads-ups pass the link check (review blocker 3)", () => {
  it("strips a blocked link from the heads-up before sending it", async () => {
    const h = makeHarness({ replies: ["DEEP: Checking https://blocked.example now.", "Here is the answer."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hard question", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sent(h).join(" ")).not.toContain("blocked.example");
    expect(sent(h)).toContain("Checking (link removed) now.");
  });
});

describe("the runner guards with the configured model ID (review blocker 4)", () => {
  it("replaces a self-description that names the responder's own model", async () => {
    const replies = ["I'm acme-reply-7, happy to help."];
    const responder: Responder = {
      name: "configured",
      model: "acme-reply-7",
      maxAttempts: 1,
      respond: async () => {
        const text = replies.shift() ?? "";
        return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "acme-reply-7", attempts: 1 };
      },
    };
    const h = makeHarness({ responder });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "what model are you", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sent(h).join(" ")).not.toContain("acme-reply-7");
  });
});
