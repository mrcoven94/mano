/// <reference types="node" />
// LAP-508: dynamic reactions and the eyes while a slow turn runs.
// LAP-850: Mano never sets a chat background, and removes one an earlier
// version set, once.
import { describe, expect, it } from "vitest";
import type { Responder, RespondHooks, TurnInput } from "@mano/channels";
import { CRISIS_LINE, EYES } from "@mano/persona";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SqlConversationStore } from "../src/store-sql.js";
import { backgroundKey } from "../src/runner.js";
import { TEST_CHAT, inboundEvent, makeHarness, runTurnAfterBatch, seedBackground, type Harness } from "./helpers.js";

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
  const wrap = <K extends "react" | "setTyping" | "send" | "clearBackground">(name: K, label: (...a: never[]) => string) => {
    const original = (c[name] as unknown as (...a: unknown[]) => Promise<unknown>).bind(c);
    (c as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      order.push((label as (...a: unknown[]) => string)(...args));
      return original(...args);
    };
  };
  wrap("react", (_c: string, _m: string, r: string) => `+${r}`);
  wrap("setTyping", (_c: string, s: string) => `typing:${s}`);
  wrap("send", (i: { text: string }) => `send:${i.text}`);
  wrap("clearBackground", () => "clear background");
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
    expect(await say(h, "evt_done", "mailed it!")).toEqual(["nice, that's the hard part done"]);
    expect(h.channel.reactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_done", reaction: "💪" }]);
  });

  it("never reacts to a reaction that arrived as text", async () => {
    const h = introduced(makeHarness({ replies: ["REACT: love"] }));
    await say(h, "evt_loved", "Loved “your renewal is due Friday”");
    expect(h.channel.reactions).toEqual([]);
  });
});

describe("eyes while a slow turn runs", () => {
  it("puts eyes on a photo once, and never takes them off", async () => {
    const h = introduced(makeHarness({ replies: ["got it, reading it now"] }));
    await say(h, "evt_photo", "what is this", { attachments: [{ url: "https://bucket.blooio.com/a.jpg", name: "a.jpg", mediaType: "image/jpeg" }] });
    expect(h.channel.reactions).toEqual([{ chatId: TEST_CHAT, messageId: "msg_evt_photo", reaction: EYES }]);
  });

  it("puts eyes on the message when the turn routes deep, and then no other reaction on it", async () => {
    const h = introduced(makeHarness({ responder: deep("REACT: like\nok, CalFresh counts what you share with your roommate") }));
    await say(h, "evt_deep", "ok how does CalFresh count my roommate's income");
    expect(h.channel.reactions.map((r) => r.reaction)).toEqual([EYES]);
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

describe("an old chat background, removed once and never set (LAP-850)", () => {
  async function record(h: Harness) {
    return h.store.chatBackground(await backgroundKey(TEST_CHAT));
  }

  it("removes it after the first reply is sent, and never again", async () => {
    const h = makeHarness({ replies: ["first answer", "second answer"] });
    await seedBackground(h, "set");
    const order = trace(h);
    await say(h, "evt_1", "hi the food bank said to text this");
    expect(h.channel.backgroundClears).toEqual([TEST_CHAT]);
    const lastSend = order.map((o) => o.startsWith("send:")).lastIndexOf(true);
    expect(order.indexOf("clear background")).toBeGreaterThan(lastSend);
    expect(order.indexOf("clear background")).toBeGreaterThan(order.lastIndexOf("typing:stopped"));
    expect(await record(h)).toMatchObject({ state: "cleared", attempts: 1 });
    await say(h, "evt_2", "ok thanks");
    expect(h.channel.backgroundClears).toHaveLength(1);
  });

  it("removes one an uncertain upload may have left, and leaves other chats alone", async () => {
    const uncertain = makeHarness({ replies: ["hello"] });
    await seedBackground(uncertain, "uncertain");
    await say(uncertain, "evt_1", "hi");
    expect(uncertain.channel.backgroundClears).toEqual([TEST_CHAT]);

    for (const state of [null, "failed", "cleared"] as const) {
      const h = makeHarness({ replies: ["hello"] });
      if (state) await seedBackground(h, state);
      await say(h, "evt_1", "hi");
      expect(h.channel.backgroundClears, String(state)).toEqual([]);
    }
  });

  it("never sets a background, whatever the chat's record says", async () => {
    for (const state of [null, "set", "uncertain", "failed", "clearing", "cleared"] as const) {
      const h = makeHarness({ replies: ["a", "b"] });
      if (state) await seedBackground(h, state);
      const setCalls: unknown[] = [];
      Object.assign(h.channel, { setBackground: async (...args: unknown[]) => void setCalls.push(args) });
      await say(h, "evt_1", "hi");
      await say(h, "evt_2", "ok");
      expect(setCalls, String(state)).toEqual([]);
    }
  });

  it("is not removed after STOP, on a closed chat, or on a crisis turn", async () => {
    const stopped = makeHarness({ replies: ["hello"] });
    await seedBackground(stopped, "set");
    stopped.store.patchMeta({ optedOut: true, optOutAtMs: stopped.now - 10_000, optOutReceivedAtMs: stopped.now - 10_000 });
    await stopped.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: stopped.now - 20_000 }), "webhook");
    expect(stopped.channel.backgroundClears).toEqual([]);

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
    const closed = makeHarness({ responder: closing });
    await seedBackground(closed, "set");
    closedStore = closed.store;
    await closed.runner.handleEvent(inboundEvent({ id: "evt_1", text: "hi", occurredAtMs: closed.now }), "webhook");
    closed.advance(closed.batchMs + 100);
    await closed.runner.runDueTurn();
    await closed.decorations.idle();
    expect(closed.channel.backgroundClears).toEqual([]);

    const crisis = makeHarness({ replies: ["I'm here."] });
    await seedBackground(crisis, "set");
    await say(crisis, "evt_c", "I want to die");
    expect(crisis.channel.backgroundClears).toEqual([]);
  });

  it("stops after three failed removals, and a failure never touches the reply", async () => {
    const h = makeHarness({ replies: ["a", "b", "c", "d"] });
    await seedBackground(h, "set");
    h.channel.clearOutcome = "failed";
    for (const [i, text] of ["one", "two", "three", "four"].entries()) {
      expect(await say(h, `evt_${i}`, text)).toContain(["a", "b", "c", "d"][i]);
    }
    expect(h.channel.backgroundClears).toHaveLength(3);
    expect(await record(h)).toMatchObject({ state: "clearing", attempts: 3 });
  });

  it("tries again after a failed removal and then stops", async () => {
    const h = makeHarness({ replies: ["a", "b", "c"] });
    await seedBackground(h, "set");
    h.channel.clearOutcome = "failed";
    await say(h, "evt_1", "one");
    h.channel.clearOutcome = "cleared";
    await say(h, "evt_2", "two");
    await say(h, "evt_3", "three");
    expect(h.channel.backgroundClears).toEqual([TEST_CHAT, TEST_CHAT]);
    expect(await record(h)).toMatchObject({ state: "cleared", attempts: 2 });
  });

  it("keeps the record across a delete, so it is removed at most once", async () => {
    const h = makeHarness({ replies: ["hello"] });
    await seedBackground(h, "set");
    await say(h, "evt_1", "hi");
    h.store.wipe(h.now);
    expect((await record(h))?.state).toBe("cleared");
  });
});

describe("the SQL store keeps the background record", () => {
  it("round-trips it per chat and keeps it across a wipe", () => {
    const store = new SqlConversationStore(sqliteStorage(new DatabaseSync(":memory:")));
    store.saveChatBackground({ chatKey: "k1", state: "clearing", attempts: 1, lockedUntilMs: 9999, updatedAtMs: 1234 });
    expect(store.chatBackground("k1")).toEqual({ chatKey: "k1", state: "clearing", attempts: 1, lockedUntilMs: 9999, updatedAtMs: 1234 });
    expect(store.chatBackground("k2")).toBeNull();
    store.wipe(5678);
    expect(store.chatBackground("k1")?.state).toBe("clearing");
  });
});
