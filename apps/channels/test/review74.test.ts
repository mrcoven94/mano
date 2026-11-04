// Sol's review of PR 74 at 926a546: two blockers and five shoulds, each
// pinned by a runner test that failed before the fix.
import { describe, expect, it } from "vitest";
import type { Responder, RespondHooks, TurnInput } from "@mano/channels";
import { CRISIS_LINE, EYES } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, seedBackground, TEST_CHAT, type Harness } from "./helpers.js";

function introduced(h: Harness): Harness {
  h.store.patchMeta({ introduced: true });
  return h;
}

async function say(h: Harness, id: string, text: string, extra: Partial<Parameters<typeof inboundEvent>[0]> = {}): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now, ...extra }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

// Answers through the deep path with a heads-up first.
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

function fixed(text: string, tapback: string | null): Responder {
  return {
    name: "fixed",
    maxAttempts: 1,
    respond: async () => ({ text, bubbles: text ? [text] : [], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1, tapback: tapback as never }),
  };
}

function slow(text: string, ms: number): Responder {
  return {
    name: "slow",
    maxAttempts: 1,
    respond: async () => {
      await new Promise((r) => setTimeout(r, ms));
      return { text, bubbles: [text], inputChars: 10, outputChars: text.length, model: "stand-in", attempts: 1 };
    },
  };
}

describe("blocker 1: fresh STOP, closed and generation checks right before every reaction call", () => {
  // The reply's text goes first; the change lands right after it.
  function afterText(h: Harness, change: () => void): void {
    const send = h.channel.send.bind(h.channel);
    h.channel.send = async (input) => {
      const out = await send(input);
      change();
      return out;
    };
  }

  it("sends no like when STOP lands after the text went out", async () => {
    const h = introduced(makeHarness({ responder: fixed("sounds good, talk soon", "like") }));
    afterText(h, () => h.store.patchMeta({ optedOut: true }));
    await say(h, "evt_1", "ok sounds good");
    expect(h.channel.reactions).toEqual([]);
  });

  it("sends no like once the chat closed", async () => {
    const h = introduced(makeHarness({ responder: fixed("sounds good", "like") }));
    afterText(h, () => h.store.patchMeta({ closed: true }));
    await say(h, "evt_1", "ok sounds good");
    expect(h.channel.reactions).toEqual([]);
  });

  it("sends no eyes when STOP lands before the eyes go out", async () => {
    const h = introduced(makeHarness({ responder: deep("here's how that works", null) }));
    const respond = h.responder.respond.bind(h.responder);
    h.responder.respond = async (turn, hooks) =>
      respond(turn, {
        onHeadsUp: async (text) => {
          h.store.patchMeta({ optedOut: true });
          await hooks?.onHeadsUp?.(text);
        },
      });
    await say(h, "evt_1", "how does CalFresh count income").catch(() => []);
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("blocker 2: decoration never blocks the turn chain", () => {
  it("runs a queued crisis message at once while a background removal hangs", async () => {
    const h = makeHarness({ replies: ["hello", "I'm here."] });
    await seedBackground(h, "set");
    h.channel.clearOutcome = "hang";
    const first = say(h, "evt_1", "hi");
    const finished = await Promise.race([first.then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 500))]);
    expect(finished).toBe("done");
    // The removal has started and hangs.
    for (let i = 0; i < 50 && h.channel.clearSignals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.channel.clearSignals).toHaveLength(1);
    expect(h.decorations.size).toBe(1);
    const sent = await Promise.race([say(h, "evt_2", "I want to die"), new Promise<string[]>((r) => setTimeout(() => r(["blocked"]), 500))]);
    expect(sent[0]).toBe(CRISIS_LINE);
    // STOP cancels the hanging removal.
    await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
    expect(h.channel.clearSignals[0]?.aborted).toBe(true);
    await h.decorations.idle();
  });

  it("bounds decoration work with a timeout", async () => {
    const h = makeHarness({ replies: ["hello"], decorationTimeoutMs: 30 });
    await seedBackground(h, "set");
    h.channel.clearOutcome = "hang";
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    expect(h.channel.clearSignals[0]?.aborted).toBe(true);
    expect(h.decorations.size).toBe(0);
  });
});

describe("blocker 3: a question always gets words, deep path included", () => {
  it("sends words when a deep answer to a question came back as a reaction alone", async () => {
    const h = introduced(makeHarness({ responder: deep("", "like") }));
    const sent = await say(h, "evt_q", "When is my SNAP renewal due?");
    expect(sent.join(" ").trim().length).toBeGreaterThan(0);
  });
});

describe("should 4: one gate for sentiment reactions; the eyes are a status signal (final review, 3)", () => {
  it("puts no eyes on a slow turn about a reaction text", async () => {
    const h = introduced(makeHarness({ responder: slow("ok", 60), config: { eyesAfterMs: 10 } }));
    await say(h, "evt_1", "Loved \u201cyour renewal is due Friday\u201d");
    expect(h.channel.reactions).toEqual([]);
  });

  it("puts the eyes on a photo sent with bad news, and nothing else", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love\ngot it, reading it now"] }));
    await say(h, "evt_1", "they denied my medicaid, here's the letter", { attachments: [{ url: "https://bucket.blooio.com/a.jpg", mediaType: "image/jpeg" }] });
    await h.decorations.idle();
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES]);
  });

  it("sends no like on bad news", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: like\nthat's a hard letter. send me a photo of it"] }));
    await say(h, "evt_1", "they denied my medicaid");
    await h.decorations.idle();
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("should 6: the background record is kept per chat, not per person", () => {
  it("removes it on each chat that had one", async () => {
    const h = makeHarness({ replies: ["a", "b"] });
    await seedBackground(h, "set");
    await seedBackground(h, "set", "chat_test_bbb");
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    await say(h, "evt_2", "hi again", { chatId: "chat_test_bbb" });
    await h.decorations.idle();
    expect(h.channel.backgroundClears).toEqual([TEST_CHAT, "chat_test_bbb"]);
  });
});
