/// <reference types="node" />
// The crisis decision in the worker (Sol's third review of PR 77): the
// keyword floor, and for one short health question a model check where
// only an exact "no" exempts. Without a check the worker fails closed.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlConversationStore } from "../src/store-sql.js";
import type { CrisisCheck } from "@mano/persona";
import { CRISIS_LINE } from "@mano/persona";
import { inboundEvent, makeHarness, runTurnAfterBatch, type Harness } from "./helpers.js";

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

const check = (answer: string): CrisisCheck & { asked: string[] } => {
  const c = { live: true, asked: [] as string[], ask: async (text: string) => (c.asked.push(text), answer) };
  return c;
};

const QUESTION = "Should I stop taking my blood pressure pills?";

describe("the worker's crisis decision", () => {
  it("answers a health question without the crisis line when the check says no", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["don't stop them on your own. a doctor or pharmacist can tell you"], crisisCheck: c });
    h.store.patchMeta({ introduced: true });
    const sent = await say(h, "evt_1", QUESTION);
    expect(sent).toEqual(["don't stop them on your own. a doctor or pharmacist can tell you"]);
    expect(c.asked).toEqual([QUESTION]);
    // Only the decision and its time are logged, never the message.
    const logged = h.lines.filter((l) => l.includes("crisis_check"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain("blood pressure");
  });

  it("sends the crisis line when the check says yes, says anything else, or is missing", async () => {
    for (const c of [check("yes"), check("No."), null]) {
      const h = makeHarness({ replies: ["a doctor can tell you"], crisisCheck: c });
      h.store.patchMeta({ introduced: true });
      expect((await say(h, "evt_1", QUESTION))[0]).toBe(CRISIS_LINE);
    }
  });

  it("never asks the model about a message that is not one short health question", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["I'm here."], crisisCheck: c });
    h.store.patchMeta({ introduced: true });
    expect((await say(h, "evt_1", "I want to hurt myself tonight."))[0]).toBe(CRISIS_LINE);
    expect(c.asked).toEqual([]);
  });
});

describe("the worker builds the check only on a Standard model with a key", () => {
  it("fails closed without a key or with a -contributor ID", async () => {
    const { buildCrisisCheck } = await import("../src/conversation.js");
    expect(buildCrisisCheck({ MANO_REPLY_MODEL: "muse-spark-1.3" } as never)).toBeNull();
    expect(buildCrisisCheck({ META_MODEL_API_KEY: "test-key-not-real", MANO_REPLY_MODEL: "muse-spark-1.3-contributor" } as never)).toBeNull();
    expect(buildCrisisCheck({ META_MODEL_API_KEY: "test-key-not-real", MANO_REPLY_MODEL: "muse-spark-1.3" } as never)?.live).toBe(true);
  });
});

describe("one decision on the whole message, before any split (Sol's fourth review, 1)", () => {
  it("keeps every chunk of a long crisis message a crisis, and never asks the model", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["part one", "part two"], crisisCheck: c });
    h.store.patchMeta({ introduced: true });
    await h.runner.handleEvent(inboundEvent({ id: "evt_long", text: "Can " + "a".repeat(3993) + " suicide?", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    await h.runner.runDueTurn();
    for (let i = 0; i < 3 && h.store.pending().length > 0; i++) await h.runner.runDueTurn();
    const lines = h.channel.sends.filter((s) => s.text === CRISIS_LINE);
    expect(h.store.recentTurns(5).length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBe(h.store.recentTurns(5).length);
    expect(c.asked).toEqual([]);
  });

  it("asks once for a short question, before the turn, and carries the answer", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["a doctor can tell you"], crisisCheck: c });
    h.store.patchMeta({ introduced: true });
    expect(await say(h, "evt_1", QUESTION)).toEqual(["a doctor can tell you"]);
    expect(c.asked).toHaveLength(1);
  });
});

describe("the whole-message decision survives retries and restarts (Sol's fifth review, 1)", () => {
  const LONG = "Can " + "a".repeat(3993) + " suicide?";
  for (const method of ["startTurn", "updateTurnAnswer", "markTurnSettled", "finishTurn", "clearPending"] as const) {
    it(`every chunk gets the crisis line when ${method} fails once`, async () => {
      const c = check("no");
      const h = makeHarness({ replies: ["part one", "part two", "part three"], crisisCheck: c });
      h.store.patchMeta({ introduced: true });
      const store = h.store as unknown as Record<string, (...a: unknown[]) => unknown>;
      const original = store[method]!.bind(h.store);
      let fail = true;
      store[method] = (...args: unknown[]) => {
        if (fail) {
          fail = false;
          throw new Error(`storage failed in ${method}`);
        }
        return original(...args);
      };
      await h.runner.handleEvent(inboundEvent({ id: "evt_long", text: LONG, occurredAtMs: h.now }), "webhook");
      h.advance(h.batchMs + 100);
      for (let i = 0; i < 12 && (h.store.pending().length > 0 || h.store.unfinishedTurn()); i++) {
        h.advance(60_000);
        await h.runner.runDueTurn().catch(() => "threw");
      }
      const sentTurns = new Set(h.store.outbounds().filter((r) => r.state === "sent" && r.tag === "").map((r) => r.turn));
      expect(sentTurns.size).toBeGreaterThanOrEqual(2);
      for (const turn of sentTurns) {
        expect(h.store.outbounds().some((r) => r.turn === turn && r.text === CRISIS_LINE && r.state === "sent"), `turn ${turn}`).toBe(true);
      }
      expect(c.asked).toEqual([]);
    });
  }

  it("persists the decision with the inbound pieces, so a fresh runner reads it", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["ok"], crisisCheck: c });
    await h.runner.handleEvent(inboundEvent({ id: "evt_q", text: QUESTION, occurredAtMs: h.now }), "webhook");
    const store = h.store as unknown as { startTurn: (...a: unknown[]) => unknown };
    const startTurn = store.startTurn.bind(h.store);
    store.startTurn = () => {
      throw new Error("down");
    };
    h.advance(h.batchMs + 100);
    await h.runner.runDueTurn().catch(() => "threw");
    expect(h.store.pending().map((p) => p.crisis)).toEqual([false]);
    store.startTurn = startTurn;
    await h.runner.runDueTurn();
    expect(c.asked).toHaveLength(1);
  });
});

describe("the stored decision on the SQL store", () => {
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

  it("keeps every chunk a crisis when a settle fails once, on SQLite", async () => {
    const c = check("no");
    const h = makeHarness({ replies: ["part one", "part two"], crisisCheck: c, store: new SqlConversationStore(sqliteStorage(new DatabaseSync(":memory:"))) });
    h.store.patchMeta({ introduced: true });
    const store = h.store as unknown as { markTurnSettled: (...a: unknown[]) => unknown };
    const settle = store.markTurnSettled.bind(h.store);
    let fail = true;
    store.markTurnSettled = (...args: unknown[]) => {
      if (fail) {
        fail = false;
        throw new Error("storage failed");
      }
      return settle(...args);
    };
    await h.runner.handleEvent(inboundEvent({ id: "evt_long", text: "Can " + "a".repeat(3993) + " suicide?", occurredAtMs: h.now }), "webhook");
    h.advance(h.batchMs + 100);
    for (let i = 0; i < 12 && (h.store.pending().length > 0 || h.store.unfinishedTurn()); i++) {
      h.advance(60_000);
      await h.runner.runDueTurn().catch(() => "threw");
    }
    const sentTurns = new Set(h.store.outbounds().filter((r) => r.state === "sent" && r.tag === "").map((r) => r.turn));
    expect(sentTurns.size).toBeGreaterThanOrEqual(2);
    for (const turn of sentTurns) expect(h.store.outbounds().some((r) => r.turn === turn && r.text === CRISIS_LINE)).toBe(true);
  });
});

describe("a missing stored decision means crisis, always (Sol's sixth review)", () => {
  function sqlite(db: DatabaseSync): SqlStorage {
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

  it("upgrades pieces left pending by the previous release to crisis, and every piece gets the line", async () => {
    // The previous release's database: no crisis column, a long message
    // split into two pieces, the first one's turn started but never
    // settled (markTurnSettled failed), the second still pending.
    const db = new DatabaseSync(":memory:");
    new SqlConversationStore(sqlite(db));
    db.exec("ALTER TABLE pending DROP COLUMN crisis");
    const LONG = "Can " + "a".repeat(3993) + " suicide?";
    const first = LONG.slice(0, 4000);
    const second = LONG.slice(4000);
    const insert = db.prepare("INSERT INTO pending (event_id, received_at_ms, chat_id, handle_to, text, attachments_json, from_reconcile, message_id) VALUES (?, ?, ?, ?, ?, '[]', 0, ?)");
    const now = Date.parse("2026-10-28T12:00:00Z");
    insert.run("evt_long#2", now, "chat_test_aaa", "+15550001001", second, null);
    db.prepare("UPDATE meta SET introduced = 1, turn = 1, chat_id = 'chat_test_aaa', handle_to = '+15550001001' WHERE id = 1").run();
    db.prepare(
      "INSERT INTO turns (turn, items_json, chat_id, handle_to, answer_json, cost_usd, cost_settled, attempts, state, created_at_ms, updated_at_ms) VALUES (1, ?, 'chat_test_aaa', '+15550001001', NULL, NULL, 0, 1, 'started', ?, ?)",
    ).run(JSON.stringify([{ eventId: "evt_long", receivedAtMs: now, chatId: "chat_test_aaa", to: "+15550001001", text: first, attachments: [], fromReconcile: false, messageId: "msg_evt_long" }]), now, now);
    insert.run("evt_long", now, "chat_test_aaa", "+15550001001", first, "msg_evt_long");

    // Upgrade: the new store on the same database, then resume.
    const c = check("no");
    const h = makeHarness({ replies: ["part one", "part two"], crisisCheck: c, store: new SqlConversationStore(sqlite(db)), startMs: now });
    expect(h.store.pending().every((p) => p.crisis === true)).toBe(true);
    h.advance(h.batchMs + 100);
    for (let i = 0; i < 12 && (h.store.pending().length > 0 || h.store.unfinishedTurn()); i++) {
      h.advance(60_000);
      await h.runner.runDueTurn().catch(() => "threw");
    }
    const sentTurns = new Set(h.store.outbounds().filter((r) => r.state === "sent" && r.tag === "").map((r) => r.turn));
    expect(sentTurns.size).toBeGreaterThanOrEqual(2);
    for (const turn of sentTurns) expect(h.store.outbounds().some((r) => r.turn === turn && r.text === CRISIS_LINE), `turn ${turn}`).toBe(true);
    expect(c.asked).toEqual([]);
  });

  it("stores a decision on every piece when the message arrives", async () => {
    const h = makeHarness({ replies: ["ok"], crisisCheck: check("no") });
    await h.runner.handleEvent(inboundEvent({ id: "evt_a", text: "What documents do I need for WIC?", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_b", text: "I want to hurt myself tonight.", occurredAtMs: h.now }), "webhook");
    await h.runner.handleEvent(inboundEvent({ id: "evt_c", text: QUESTION, occurredAtMs: h.now }), "webhook");
    expect(h.store.pending().map((p) => p.crisis)).toEqual([false, true, "ask"]);
  });
});
