import { describe, expect, it } from "vitest";
import { SparkResponder, StandInResponder } from "@mano/channels";
import { SAFE_REPLY, SELF_DESCRIPTION, guardReply } from "@mano/persona";
import { buildResponder } from "../src/conversation.js";
import type { Env } from "../src/env.js";
import { FAILURE_BUBBLE, INTRO_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

const DIRTY = "I'm Muse Spark! **Happy** to help — what's going on?";
const CLEAN = `${SELF_DESCRIPTION} Happy to help, what's going on?`;

function sentTexts(h: Harness): string[] {
  return h.channel.sends.map((s) => s.text);
}

function expectAllInVoice(h: Harness): void {
  expect(h.channel.sends.length).toBeGreaterThan(0);
  for (const text of sentTexts(h)) {
    expect(text.trim().length).toBeGreaterThan(0);
    expect(guardReply(text)).toEqual({ text, changes: [] });
  }
}

describe("the voice guard on every send path", () => {
  it("guards the webhook fast path", async () => {
    const h = makeHarness({ replies: [DIRTY] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "what model are you", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)).toEqual([INTRO_BUBBLE, CLEAN]);
    expectAllInVoice(h);
    const logs = h.lines.join("\n");
    expect(logs).toContain("voice_guarded");
    expect(logs).not.toContain("Muse");
  });

  it("guards the reconcile path", async () => {
    const h = makeHarness({ replies: [DIRTY] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_feed_1", text: "what model are you", occurredAtMs: h.now }), "reconcile");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)).toEqual([INTRO_BUBBLE, CLEAN]);
    expectAllInVoice(h);
  });

  it("sends the deep-path heads-up after the intro and before the answer, both guarded", async () => {
    const h = makeHarness({ replies: ["DEEP: Let me check Ohio's rules — one sec.", "## The short answer\n- You **likely** qualify"] });
    await h.runner.handleEvent(
      inboundEvent({ id: "evt_1", text: "I make $2,100 a month in Ohio with 2 kids, do I qualify for SNAP?", occurredAtMs: h.now }),
      "webhook",
    );
    await runTurnAfterBatch(h);
    expect(sentTexts(h)).toEqual([INTRO_BUBBLE, "Let me check Ohio's rules, one sec.", "The short answer. You likely qualify."]);
    expectAllInVoice(h);
    expect(h.lines.join("\n")).toContain("heads_up_sent");
  });

  it("sends the heads-up without a second intro once Mano is introduced", async () => {
    const h = makeHarness({ replies: ["Hey.", "DEEP: Checking that.", "Here it is."] });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "hard question", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)).toEqual([INTRO_BUBBLE, "Hey.", "Checking that.", "Here it is."]);
  });

  it("guards the failure reply", async () => {
    const h = makeHarness({
      responder: {
        name: "broken",
        maxAttempts: 1,
        respond: async () => {
          throw new Error("model down");
        },
      },
    });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Hello.", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(sentTexts(h)).toEqual([INTRO_BUBBLE, FAILURE_BUBBLE]);
    expectAllInVoice(h);
  });

  it("never sends an empty text: an unsendable answer becomes the safe line", async () => {
    for (const reply of ["", "**", "Gemini."]) {
      const h = makeHarness({ replies: [reply] });
      await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: h.now }), "webhook");
      await runTurnAfterBatch(h);
      expect(sentTexts(h)).toEqual([INTRO_BUBBLE, SAFE_REPLY]);
      expectAllInVoice(h);
    }
  });
});

describe("conversation history", () => {
  it("gives the responder earlier turns as roles, and the intro on first contact", async () => {
    const responder = new StandInResponder(["What date is on the letter?", "Then you have until March 3."]);
    const h = makeHarness({ responder });
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "my food stamps are ending", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "march 3", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    expect(responder.prompts[0].history).toEqual([{ role: "mano", text: INTRO_BUBBLE }]);
    expect(responder.prompts[1].history).toEqual([
      { role: "person", text: "my food stamps are ending" },
      { role: "mano", text: `${INTRO_BUBBLE} What date is on the letter?` },
    ]);
    expect(responder.prompts[1].texts).toEqual(["march 3"]);
  });
});

describe("buildResponder", () => {
  const base = { META_MODEL_API_KEY: "test-key-not-real" } as Env;

  it("answers real texts only with a Standard model ID from config", () => {
    const live = buildResponder({ ...base, MANO_REPLY_MODEL: "muse-spark-1.3" });
    expect(live).toBeInstanceOf(SparkResponder);
    expect((live as SparkResponder).model).toBe("muse-spark-1.3");
  });

  it("fails closed to the stand-in for a -contributor or missing model ID", () => {
    expect(buildResponder({ ...base, MANO_REPLY_MODEL: "muse-spark-1.3-contributor" })).toBeInstanceOf(StandInResponder);
    expect(buildResponder(base)).toBeInstanceOf(StandInResponder);
  });
});
