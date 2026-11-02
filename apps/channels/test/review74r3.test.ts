// Sol's third review of PR 74 at b4cf8ce: five reproductions, each a
// runner test that failed before the final simplification.
import { describe, expect, it } from "vitest";
import type { Responder, RespondHooks, TurnInput } from "@mano/channels";
import { CRISIS_LINE, EYES } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, TEST_CHAT, type Harness } from "./helpers.js";

function introduced(h: Harness): Harness {
  h.store.patchMeta({ introduced: true });
  return h;
}

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

function reply(text: string, tapback: string | null): Responder {
  return {
    name: "fixed",
    maxAttempts: 1,
    respond: async () => ({ text, bubbles: text ? [text] : [], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never }),
  };
}

// Replies in turn order: each call takes the next one.
function replies(...answers: Array<[string, string | null]>): Responder {
  const queue = [...answers];
  return {
    name: "queue",
    maxAttempts: 1,
    respond: async () => {
      const [text, tapback] = queue.shift() ?? ["ok", null];
      return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never };
    },
  };
}

function slow(text: string, ms: number): Responder {
  return {
    name: "slow",
    maxAttempts: 1,
    respond: async (_t: TurnInput, _h: RespondHooks = {}) => {
      await new Promise((r) => setTimeout(r, ms));
      return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1 };
    },
  };
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | "blocked"> => Promise.race([p, new Promise<"blocked">((r) => setTimeout(() => r("blocked"), ms))]);

describe("Sol round 3, repro 1: STOP cancels the eyes timer", () => {
  it("puts no eyes on a slow turn after STOP, and leaves no timer pending", async () => {
    const h = introduced(makeHarness({ responder: slow("here's the plan", 120), config: { eyesAfterMs: 60 } }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "can you look at my case", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 20));
    await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
    expect(h.decorations.pendingTimers).toBe(0);
    await turn;
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });

  it("a closed chat cancels the eyes timer too", async () => {
    const h = introduced(makeHarness({ responder: slow("ok", 120), config: { eyesAfterMs: 60 } }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "can you look at my case", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    const turn = h.runner.runDueTurn();
    await new Promise((r) => setTimeout(r, 20));
    await h.runner.handleEvent({ ...inboundEvent({ id: "evt_close", occurredAtMs: h.now }), kind: "chat.closed", rawType: "chat.closed", text: null, messageId: null }, "webhook");
    expect(h.decorations.pendingTimers).toBe(0);
    await turn;
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("Sol round 3, repro 2: a reply's reaction never blocks the next turn", () => {
  it("runs a queued crisis message at once while every reaction call hangs", async () => {
    const h = introduced(makeHarness({ responder: replies(["anytime!", "love"], ["I'm here.", null]) }));
    h.channel.react = () => new Promise<never>(() => {});
    expect(await within(say(h, "evt_1", "thank you"), 500)).toEqual(["anytime!"]);
    const sent = await within(say(h, "evt_2", "I want to die"), 500);
    expect(sent).not.toBe("blocked");
    expect((sent as string[])[0]).toBe(CRISIS_LINE);
  });

  it("runs the next turn while a pending eyes call hangs", async () => {
    const h = introduced(makeHarness({ responder: slow("here it is", 80), config: { eyesAfterMs: 10 } }));
    h.channel.react = () => new Promise<never>(() => {});
    expect(await within(say(h, "evt_1", "can you look at my case"), 1000)).toEqual(["here it is"]);
    expect(await within(say(h, "evt_2", "ok"), 1000)).not.toBe("blocked");
  });
});

describe("Sol round 3, repro 3: the bad-news veto", () => {
  for (const text of ["thanks, my benefits were reduced", "thanks, I can’t pay rent this month", "thank you, I don’t have food", "gracias, me redujeron los beneficios", "thanks, the bill is overdue"]) {
    it(`puts no reaction on "${text}"`, async () => {
      const h = introduced(makeHarness({ responder: reply("that's a lot. let's look at it together", "love") }));
      await say(h, "evt_1", text);
      await h.decorations.idle();
      expect(h.channel.reactions).toEqual([]);
    });
  }
});

describe("Sol round 3, repro 4: every reply has words, so no question goes unanswered", () => {
  for (const text of ["thanks, should I mail it", "ok must I send the pay stub too"]) {
    it(`sends words to "${text}" even when the model wrote a reaction alone`, async () => {
      const h = introduced(makeHarness({ responder: reply("", "love") }));
      const sent = await say(h, "evt_1", text);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.join(" ").trim().length).toBeGreaterThan(0);
    });
  }

  it("never answers a plain thanks with a reaction alone", async () => {
    const h = introduced(makeHarness({ responder: reply("", "love") }));
    const sent = await say(h, "evt_1", "thank you!!");
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("Sol round 3, repro 5: a reaction text first in a batch hides nothing", () => {
  it("answers a later question in words, and reacts only to the last message", async () => {
    const h = introduced(makeHarness({ responder: reply("", "like") }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Loved “your renewal is due Friday”", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "ok should I mail it today", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    await h.decorations.idle();
    expect(h.channel.sends.length).toBeGreaterThan(0);
    expect(h.channel.reactions.every((r) => r.messageId === "msg_evt_2")).toBe(true);
  });
});

describe("reactions go on top of words, outside the turn", () => {
  it("adds the reply's reaction after its words", async () => {
    const h = introduced(makeHarness({ responder: reply("anytime!", "love") }));
    expect(await say(h, "evt_1", "thank you")).toEqual(["anytime!"]);
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_1", reaction: "love" }]);
  });

  it("still never stacks a reaction on a message with the eyes", async () => {
    const h = introduced(makeHarness({ responder: slow("here it is", 60), config: { eyesAfterMs: 10 } }));
    await say(h, "evt_1", "thanks, can you look at my case");
    await h.decorations.idle();
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES]);
  });
});
