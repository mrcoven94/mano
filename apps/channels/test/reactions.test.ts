/// <reference types="node" />
// LAP-508: dynamic reactions, the eyes while a slow turn runs, and the
// chat background set once.
import { describe, expect, it } from "vitest";
import type { Responder, RespondHooks, TurnInput } from "@mano/channels";
import { CRISIS_LINE, EYES } from "@mano/persona";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SqlConversationStore } from "../src/store-sql.js";
import { backgroundKey } from "../src/runner.js";
import { TEST_CHAT, inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

function sqliteStorage(db: DatabaseSync): SqlStorage {
  return {
    exec(sql: string, ...params: unknown[]) {
      const select = /^\s*(SELECT|WITH)\b/i.test(sql);
      if (!select && params.length === 0 && sql.includes(";")) {
        db.exec(sql);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(sql);
      const args = params as SQLInputValue[];
      if (select) return { toArray: () => stmt.all(...args) };
      stmt.run(...args);
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
}

const BACKGROUND_URL = "https://withmano.example/chat-background.png";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function introduced(h: Harness): Harness {
  const meta = h.store.meta();
  meta.introduced = true;
  h.store.saveMeta(meta);
  return h;
}

async function say(h: Harness, id: string, text: string, extra: Partial<Parameters<typeof inboundEvent>[0]> = {}): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now, ...extra }), "webhook");
  await runTurnAfterBatch(h);
  // Decoration runs outside the turn; the tests wait for it to settle.
  await h.decorations.idle();
  return h.channel.sends.slice(before).map((s) => s.text);
}

// Every channel call in order, so "eyes before typing" is checkable.
function trace(h: Harness): string[] {
  const order: string[] = [];
  const c = h.channel;
  const wrap = <K extends "react" | "unreact" | "setTyping" | "send" | "setBackground">(name: K, label: (...a: never[]) => string) => {
    const original = (c[name] as (...a: unknown[]) => Promise<unknown>).bind(c);
    (c as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      order.push((label as (...a: unknown[]) => string)(...args));
      return original(...args);
    };
  };
  wrap("react", (_c: string, _m: string, r: string) => `+${r}`);
  wrap("unreact", (_c: string, _m: string, r: string) => `-${r}`);
  wrap("setTyping", (_c: string, s: string) => `typing:${s}`);
  wrap("send", (i: { text: string }) => `send:${i.text}`);
  wrap("setBackground", () => "background");
  return order;
}

// A responder that answers through the deep path: heads-up first.
function deep(answer: string): Responder {
  return {
    name: "deep",
    maxAttempts: 1,
    respond: async (_turn: TurnInput, hooks: RespondHooks = {}) => {
      await hooks.onHeadsUp?.("Let me check how California handles that.");
      const split = answer.startsWith("REACT: ") ? { tapback: answer.slice(7).split("\n")[0], text: answer.split("\n").slice(1).join("\n") } : { tapback: null, text: answer };
      return { text: split.text, bubbles: [split.text], inputChars: 10, outputChars: answer.length, model: "stand-in", attempts: 1, tapback: split.tapback as never };
    },
  };
}

// A fast responder that takes longer than the eyes threshold.
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

describe("dynamic reactions", () => {
  it("sends an emoji reaction the model chose", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: 💪\nnice, that's the hard part done"] }));
    expect(await say(h, "evt_done", "just mailed the renewal packet")).toEqual(["nice, that's the hard part done"]);
    expect(h.channel.reactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_done", reaction: "💪" }]);
  });

  it("never reacts to a reaction that arrived as text", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love"] }));
    await say(h, "evt_loved", "Loved “your renewal is due Friday”");
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("eyes while a slow turn runs", () => {
  it("puts eyes on a photo before the typing indicator, and leaves them when the reply has no reaction", async () => {
    const h = introduced(makeHarness({ replies: ["got it, reading it now"] }));
    const order = trace(h);
    await say(h, "evt_photo", "what is this", { attachments: [{ url: "https://bucket.blooio.com/a.jpg", name: "a.jpg", mediaType: "image/jpeg" }] });
    expect(order.indexOf(`+${EYES}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`+${EYES}`)).toBeLessThan(order.indexOf("typing:started"));
    expect(h.channel.unreactions).toEqual([]);
  });

  it("puts eyes on the message when the turn routes deep, and swaps them for the reply's reaction", async () => {
    const h = introduced(makeHarness({ responder: deep("REACT: emphasize\nCalFresh renewals are due by the date on your letter") }));
    const order = trace(h);
    await say(h, "evt_deep", "how does CalFresh count my roommate's income");
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES, "emphasize"]);
    expect(h.channel.unreactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_deep", reaction: EYES }]);
    expect(order.indexOf(`-${EYES}`)).toBeLessThan(order.indexOf("+emphasize"));
  });

  it("puts eyes on a fast turn that runs past the threshold", async () => {
    const h = introduced(makeHarness({ responder: slow("here's the plan", 80), config: { eyesAfterMs: 20 } }));
    await say(h, "evt_slow", "can you look at my case");
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES]);
  });

  it("does not put eyes on a quick fast reply", async () => {
    const h = introduced(makeHarness({ replies: ["hey!"] }));
    await say(h, "evt_hi", "hi");
    expect(h.channel.reactions).toEqual([]);
  });

  it("never puts eyes on a crisis turn", async () => {
    const h = introduced(makeHarness({ responder: deep("I'm here with you.") }));
    const sent = await say(h, "evt_c", "I want to die", { attachments: [{ url: "https://bucket.blooio.com/a.jpg", name: "a.jpg", mediaType: "image/jpeg" }] });
    expect(sent[0]).toBe(CRISIS_LINE);
    expect(h.channel.reactions).toEqual([]);
  });

  it("never lets a failed reaction block or change the reply", async () => {
    const h = introduced(makeHarness({ responder: deep("REACT: like\nhere's how it works") }));
    h.channel.failReactions = true;
    const sent = await say(h, "evt_fail", "how does this work");
    expect(sent).toContain("here's how it works");
  });
});

describe("the chat background, set once", () => {
  function withImage(): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("dns-query")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
      if (url === BACKGROUND_URL) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
  }

  it("sets it after the first reply is sent, and never again", async () => {
    const h = makeHarness({ replies: ["first answer", "second answer"], fetchFn: withImage(), config: { backgroundUrl: BACKGROUND_URL } });
    const order = trace(h);
    await say(h, "evt_1", "hi the food bank said to text this");
    expect(h.channel.backgrounds).toEqual([{ chatId: TEST_CHAT, type: "image/png", size: PNG.length }]);
    const lastSend = order.map((o) => o.startsWith("send:")).lastIndexOf(true);
    expect(order.indexOf("background")).toBeGreaterThan(lastSend);
    // The upload never holds the typing indicator up.
    expect(order.indexOf("background")).toBeGreaterThan(order.lastIndexOf("typing:stopped"));
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))?.state).toBe("set");
    await say(h, "evt_2", "ok thanks");
    expect(h.channel.backgrounds).toHaveLength(1);
  });

  it("is not set without a configured image, after STOP, or on a closed chat", async () => {
    const none = makeHarness({ replies: ["hello"], fetchFn: withImage() });
    await say(none, "evt_1", "hi");
    expect(none.channel.backgrounds).toEqual([]);

    const stopped = makeHarness({ replies: ["hello"], fetchFn: withImage(), config: { backgroundUrl: BACKGROUND_URL } });
    stopped.store.patchMeta({ optedOut: true, optOutAtMs: stopped.now - 10_000, optOutReceivedAtMs: stopped.now - 10_000 });
    await stopped.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: stopped.now - 20_000 }), "webhook");
    expect(stopped.channel.backgrounds).toEqual([]);

    // The chat closes while Mano is answering.
    let closedStore: Harness["store"] | null = null;
    const closing: Responder = {
      name: "closing",
      maxAttempts: 1,
      respond: async () => {
        closedStore!.patchMeta({ closed: true });
        return { text: "hello", bubbles: ["hello"], inputChars: 5, outputChars: 5, model: "stand-in", attempts: 1 };
      },
    };
    const closed = makeHarness({ responder: closing, fetchFn: withImage(), config: { backgroundUrl: BACKGROUND_URL } });
    closedStore = closed.store;
    await closed.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: closed.now }), "webhook");
    closed.advance(closed.batchMs + 100);
    await closed.runner.runDueTurn();
    expect(closed.channel.backgrounds).toEqual([]);
  });

  it("waits past a crisis turn", async () => {
    const h = makeHarness({ replies: ["I'm here."], fetchFn: withImage(), config: { backgroundUrl: BACKGROUND_URL } });
    await say(h, "evt_c", "I want to die");
    expect(h.channel.backgrounds).toEqual([]);
  });

  it("stops after three known failures, and a failure never touches the reply", async () => {
    const h = makeHarness({ replies: ["a", "b", "c", "d"], fetchFn: withImage(), config: { backgroundUrl: BACKGROUND_URL } });
    h.channel.backgroundOutcome = "failed";
    for (const [i, text] of ["one", "two", "three", "four"].entries()) {
      expect(await say(h, `evt_${i}`, text)).toContain(["a", "b", "c", "d"][i]);
    }
    expect(h.channel.backgrounds).toHaveLength(3);
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))).toMatchObject({ state: "failed", attempts: 3 });
  });

  it("refuses an image that is not an image", async () => {
    const html = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("dns-query")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
      return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const h = makeHarness({ replies: ["hello"], fetchFn: html, config: { backgroundUrl: BACKGROUND_URL } });
    await say(h, "evt_1", "hi");
    expect(h.channel.backgrounds).toEqual([]);
  });

  it("keeps the flag across a delete, so it is never sent again", async () => {
    const h = makeHarness({ replies: ["hello"], fetchFn: withImage(), config: { backgroundUrl: BACKGROUND_URL } });
    await say(h, "evt_1", "hi");
    h.store.wipe(h.now);
    expect(h.store.chatBackground(await backgroundKey(TEST_CHAT))?.state).toBe("set");
  });
});

describe("the SQL store keeps the background record", () => {
  it("round-trips it per chat and keeps it across a wipe", () => {
    const store = new SqlConversationStore(sqliteStorage(new DatabaseSync(":memory:")));
    store.saveChatBackground({ chatKey: "k1", state: "uncertain", attempts: 1, updatedAtMs: 1234 });
    expect(store.chatBackground("k1")).toEqual({ chatKey: "k1", state: "uncertain", attempts: 1, updatedAtMs: 1234 });
    expect(store.chatBackground("k2")).toBeNull();
    store.wipe(5678);
    expect(store.chatBackground("k1")?.state).toBe("uncertain");
  });
});
