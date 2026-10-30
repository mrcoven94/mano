// Sol's second review of PR 74 at eb7c8f4: six reproductions, each a
// runner test that failed before the simplification.
import { describe, expect, it } from "vitest";
import type { Responder, RespondHooks, TurnInput } from "@mano/channels";
import { EYES } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, TEST_CHAT, type Harness } from "./helpers.js";

const BACKGROUND_URL = "https://withmano.example/chat-background.png";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

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

// Answers through the deep path with a heads-up first, so the eyes go on.
function deep(text: string, tapback: string | null): Responder {
  return {
    name: "deep",
    maxAttempts: 1,
    respond: async (_t: TurnInput, hooks: RespondHooks = {}) => {
      await hooks.onHeadsUp?.("Let me look into that.");
      return { text, bubbles: text ? [text] : [], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never };
    },
  };
}

function reply(text: string, tapback: string | null): Responder {
  return {
    name: "fixed",
    maxAttempts: 1,
    respond: async () => ({ text, bubbles: text ? [text] : [], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never }),
  };
}

const never = (): Promise<never> => new Promise<never>(() => {});

describe("Sol round 2, repro 1: removing the eyes no longer exists, so it cannot block a turn", () => {
  it("finishes the turn while a reaction removal would hang, and puts nothing else on an eyed message", async () => {
    const h = introduced(makeHarness({ responder: deep("thanks for waiting, here it is", "love") }));
    (h.channel as unknown as Record<string, unknown>).unreact = never;
    const done = await Promise.race([say(h, "evt_1", "thank you, can you check my case").then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 2500))]);
    expect(done).toBe("done");
    await h.decorations.idle();
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES]);
  });
});

describe("Sol round 2, repro 2: nothing fires after STOP", () => {
  it("sends no reaction after STOP, even with the eyes still landing", async () => {
    const h = introduced(makeHarness({ responder: deep("ok, that's done", "like") }));
    const react = h.channel.react.bind(h.channel);
    h.channel.react = async (chatId, messageId, reaction) => {
      if (reaction === EYES) await new Promise((r) => setTimeout(r, 60));
      return react(chatId, messageId, reaction);
    };
    await say(h, "evt_1", "ok sounds good");
    await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
    await new Promise((r) => setTimeout(r, 150));
    await h.decorations.idle();
    expect(h.channel.reactions.map((r) => r.reaction).filter((r) => r !== EYES)).toEqual([]);
    expect((h.channel as unknown as { unreactions?: unknown[] }).unreactions ?? []).toEqual([]);
  });
});

describe("Sol round 2, repro 3: one background upload at a time per chat", () => {
  it("never starts a second upload while the first is in flight", async () => {
    const image = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("dns-query")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
      if (url === BACKGROUND_URL) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const h = makeHarness({ replies: ["a", "b", "c"], fetchFn: image, config: { backgroundUrl: BACKGROUND_URL } });
    const set = h.channel.setBackground.bind(h.channel);
    h.channel.setBackground = async (chatId, blob, signal) => {
      await new Promise((r) => setTimeout(r, 120));
      return set(chatId, blob, signal);
    };
    await say(h, "evt_1", "hi");
    await new Promise((r) => setTimeout(r, 30));
    await say(h, "evt_2", "ok");
    await say(h, "evt_3", "cool");
    await h.decorations.idle();
    expect(h.channel.backgrounds.map((b) => b.chatId)).toEqual([TEST_CHAT]);
  });
});

describe("Sol round 2, repro 4: only the last message of a batch is a target, on its own text", () => {
  it("puts no heart on a question just because an earlier message in the batch said thanks", async () => {
    const h = introduced(makeHarness({ responder: reply("it's on your renewal letter", "love") }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "thank you!", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "my renewal letter came today", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });

  it("reacts to the last message when it is the thanks", async () => {
    const h = introduced(makeHarness({ responder: reply("anytime!", "love") }));
    await h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "Loved “your renewal is due Friday”", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_2", text: "thanks!", occurredAtMs: h.now }), "webhook");
    await runTurnAfterBatch(h);
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_2", reaction: "love" }]);
  });
});

describe("Sol round 2, repro 5: bad news never gets a reaction", () => {
  for (const text of ["I got fired", "me negaron Medicaid", "thanks, they denied it"]) {
    it(`puts no heart on "${text}"`, async () => {
      const h = introduced(makeHarness({ responder: reply("that's a hard one. what happened?", "love") }));
      await say(h, "evt_1", text);
      expect(h.channel.reactions).toEqual([]);
    });
  }
});

describe("Sol round 2, repro 6: a question without a question mark always gets words", () => {
  for (const text of ["any update on my renewal", "so when do i send it", "ok what do i do now"]) {
    it(`answers "${text}" in words`, async () => {
      const h = introduced(makeHarness({ responder: reply("", "like") }));
      const sent = await say(h, "evt_1", text);
      expect(sent.join(" ").trim().length).toBeGreaterThan(0);
    });
  }

  it("answers a plain ok in words too, with the reaction on top (review 3)", async () => {
    const h = introduced(makeHarness({ responder: reply("talk soon", "like") }));
    expect(await say(h, "evt_1", "ok sounds good")).toEqual(["talk soon"]);
    await h.decorations.idle();
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual(["like"]);
  });

  it("adds a done message's reaction on top of its words", async () => {
    const h = introduced(makeHarness({ responder: reply("nice, that's the hard part", "💪") }));
    expect(await say(h, "evt_1", "just mailed the renewal packet")).toEqual(["nice, that's the hard part"]);
    await h.decorations.idle();
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual(["💪"]);
  });

  it("drops a reaction outside the message's allowed set", async () => {
    const h = introduced(makeHarness({ responder: reply("glad it helped", "🎉") }));
    await say(h, "evt_1", "thank you");
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("live probe r-best: praise gets words and no reaction", () => {
  it("puts no heart on praise, and still sends the words", async () => {
    const h = introduced(makeHarness({ responder: reply("that means a lot", "love") }));
    expect(await say(h, "evt_1", "you're the best, seriously")).toEqual(["that means a lot"]);
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});
