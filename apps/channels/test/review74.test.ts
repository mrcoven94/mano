// Sol's review of PR 74 at 926a546: two blockers and five shoulds, each
// pinned by a runner test that failed before the fix.
import { describe, expect, it } from "vitest";
import type { Responder, RespondHooks, TurnInput } from "@mano/channels";
import { CRISIS_LINE, EYES } from "@mano/persona";
import { backgroundKey } from "../src/runner.js";
import { NEEDS_ANSWER_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, TEST_CHAT, type Harness } from "./helpers.js";

const BACKGROUND_URL = "https://withmano.example/chat-background.png";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

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

function dnsAndImage(image: () => Response = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("dns-query")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
    if (url === BACKGROUND_URL) return image();
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
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
  it("runs a queued crisis message at once while a background upload hangs", async () => {
    const h = makeHarness({ replies: ["hello", "I'm here."], fetchFn: dnsAndImage(), config: { backgroundUrl: BACKGROUND_URL } });
    h.channel.backgroundOutcome = "hang";
    const first = say(h, "evt_1", "hi");
    const finished = await Promise.race([first.then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 500))]);
    expect(finished).toBe("done");
    // The upload has started and hangs.
    for (let i = 0; i < 50 && h.channel.backgroundSignals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.channel.backgroundSignals).toHaveLength(1);
    expect(h.decorations.size).toBe(1);
    const sent = await Promise.race([say(h, "evt_2", "I want to die"), new Promise<string[]>((r) => setTimeout(() => r(["blocked"]), 500))]);
    expect(sent[0]).toBe(CRISIS_LINE);
    // STOP cancels the hanging upload.
    await h.runner.handleEvent(inboundEvent({ id: "evt_stop", text: "STOP", occurredAtMs: h.now }), "webhook");
    expect(h.channel.backgroundSignals[0]?.aborted).toBe(true);
    await h.decorations.idle();
  });

  it("bounds decoration work with a timeout", async () => {
    const h = makeHarness({ replies: ["hello"], fetchFn: dnsAndImage(), config: { backgroundUrl: BACKGROUND_URL }, decorationTimeoutMs: 30 });
    h.channel.backgroundOutcome = "hang";
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    expect(h.channel.backgroundSignals[0]?.aborted).toBe(true);
    expect(h.decorations.size).toBe(0);
  });
});

describe("blocker 3: a question always gets text, deep path included", () => {
  it("sends a guarded short fallback when a deep answer to a question is a reaction alone", async () => {
    const h = introduced(makeHarness({ responder: deep("", "like") }));
    const sent = await say(h, "evt_q", "When is my SNAP renewal due?");
    expect(sent).toContain(NEEDS_ANSWER_BUBBLE);
  });

  it("keeps a reaction alone when nothing was asked", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love"] }));
    expect(await say(h, "evt_t", "thank you!!")).toEqual([]);
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual(["love"]);
  });
});

describe("should 4: one eligibility gate for every reaction, the eyes included", () => {
  it("puts no eyes on a slow turn about a reaction text or bad news", async () => {
    for (const text of ["Loved “your renewal is due Friday”", "they denied my medicaid"]) {
      const h = introduced(makeHarness({ responder: slow("ok", 60), config: { eyesAfterMs: 10 } }));
      await say(h, "evt_1", text);
      expect(h.channel.reactions, text).toEqual([]);
    }
  });

  it("puts no eyes on a photo sent with bad news", async () => {
    const h = introduced(makeHarness({ replies: ["got it"] }));
    await say(h, "evt_1", "they denied my medicaid, here's the letter", { attachments: [{ url: "https://bucket.blooio.com/a.jpg", mediaType: "image/jpeg" }] });
    expect(h.channel.reactions).toEqual([]);
  });

  it("sends no like on bad news", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: like\nthat's a hard letter. send me a photo of it"] }));
    await say(h, "evt_1", "they denied my medicaid");
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("should 5: an uncertain upload is reconciled before any retry", () => {
  it("reads the chat back after an uncertain upload and does not upload again when it landed", async () => {
    const h = makeHarness({ replies: ["a", "b"], fetchFn: dnsAndImage(), config: { backgroundUrl: BACKGROUND_URL } });
    h.channel.backgroundOutcome = "uncertain";
    h.channel.devicesWithBackground.add(TEST_CHAT);
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    expect(h.channel.backgrounds).toHaveLength(1);
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))?.state).toBe("uncertain");
    await say(h, "evt_2", "ok");
    await h.decorations.idle();
    expect(h.channel.backgroundReads).toEqual([TEST_CHAT]);
    expect(h.channel.backgrounds).toHaveLength(1);
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))?.state).toBe("set");
  });

  it("uploads again after reading back that an uncertain upload did not land", async () => {
    const h = makeHarness({ replies: ["a", "b"], fetchFn: dnsAndImage(), config: { backgroundUrl: BACKGROUND_URL } });
    h.channel.backgroundOutcome = "uncertain";
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    h.channel.backgroundOutcome = "set";
    await say(h, "evt_2", "ok");
    await h.decorations.idle();
    expect(h.channel.backgroundReads).toEqual([TEST_CHAT]);
    expect(h.channel.backgrounds).toHaveLength(2);
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))?.state).toBe("set");
  });

  it("retries a known failure without reading back", async () => {
    const h = makeHarness({ replies: ["a", "b"], fetchFn: dnsAndImage(), config: { backgroundUrl: BACKGROUND_URL } });
    h.channel.backgroundOutcome = "failed";
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    h.channel.backgroundOutcome = "set";
    await say(h, "evt_2", "ok");
    await h.decorations.idle();
    expect(h.channel.backgroundReads).toEqual([]);
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))).toMatchObject({ state: "set", attempts: 2 });
  });
});

describe("should 6: the background is kept per chat, not per person", () => {
  it("sets it on a second chat for the same person", async () => {
    const h = makeHarness({ replies: ["a", "b"], fetchFn: dnsAndImage(), config: { backgroundUrl: BACKGROUND_URL } });
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    await say(h, "evt_2", "hi again", { chatId: "chat_test_bbb" });
    await h.decorations.idle();
    expect(h.channel.backgrounds.map((b) => b.chatId)).toEqual([TEST_CHAT, "chat_test_bbb"]);
  });
});

describe("should 7: the background download is streamed with a cap", () => {
  it("cancels the download once it passes 10 MB and uploads nothing", async () => {
    let cancelled = false;
    let pulled = 0;
    const big = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled > 20) controller.close();
            else controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "image/png" } },
      );
    const h = makeHarness({ replies: ["hello"], fetchFn: dnsAndImage(big), config: { backgroundUrl: BACKGROUND_URL } });
    await say(h, "evt_1", "hi");
    await h.decorations.idle();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(12);
    expect(h.channel.backgrounds).toEqual([]);
  });
});

describe("the background stays off until a version is checked on a phone (PR 74, David's screenshot)", () => {
  it("is off by default and on only when enabled with a URL", async () => {
    const { chatBackgroundUrl } = await import("../src/conversation.js");
    const env = { MANO_CHAT_BACKGROUND_URL: BACKGROUND_URL } as never;
    expect(chatBackgroundUrl(env)).toBeNull();
    expect(chatBackgroundUrl({ MANO_CHAT_BACKGROUND_URL: BACKGROUND_URL, MANO_CHAT_BACKGROUND_ENABLED: "false" } as never)).toBeNull();
    expect(chatBackgroundUrl({ MANO_CHAT_BACKGROUND_URL: BACKGROUND_URL, MANO_CHAT_BACKGROUND_ENABLED: "true" } as never)).toBe(BACKGROUND_URL);
    expect(chatBackgroundUrl({ MANO_CHAT_BACKGROUND_ENABLED: "true" } as never)).toBeNull();
  });
});
