/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  cancelReminder,
  claimDueReminders,
  createReminder,
  ensureAgentStateTables,
  finishReminder,
  getPendingPointer,
  getReminder,
  listReminders,
  putTurnIfAbsent,
  completeTurn,
  removeConversationState,
  setPendingPointer,
} from "../src/agents/agent-state.js";

// The agent's per-person state on real SQLite: atomic claim and cancel,
// one reminder per identity, generation-checked pointer reads, a turn
// ledger that keeps the first receive time, and delete-all.

function openDb() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureAgentStateTables(sql);
  sql.exec("CREATE TABLE approvals(id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  sql.exec("CREATE TABLE memory(id TEXT PRIMARY KEY, content TEXT NOT NULL)");
  return sql;
}

const T0 = Date.parse("2026-11-01T15:00:00Z");
const LEASE = 60_000;

describe("reminders", () => {
  it("one identity is one reminder; two identities at the same time stay two", () => {
    const sql = openDb();
    const first = createReminder(sql, { id: "turn-7:0", text: "Call the county", dueAtMs: T0, generation: 3 }, T0 - 1000);
    const again = createReminder(sql, { id: "turn-7:0", text: "Call the county", dueAtMs: T0, generation: 3 }, T0 - 500);
    const other = createReminder(sql, { id: "turn-7:1", text: "Call the county", dueAtMs: T0, generation: 3 }, T0 - 500);
    expect("created" in first && first.created).toBe(true);
    expect("created" in again && again.created).toBe(false);
    expect("created" in other && other.created).toBe(true);
    expect(listReminders(sql).map((r) => r.id)).toEqual(["turn-7:0", "turn-7:1"]);
    const changed = createReminder(sql, { id: "turn-7:0", text: "Something else", dueAtMs: T0, generation: 3 }, T0);
    expect("conflict" in changed).toBe(true);
    expect(getReminder(sql, "turn-7:0")?.text).toBe("Call the county");
  });

  it("a cancelled reminder is never claimed", () => {
    const sql = openDb();
    createReminder(sql, { id: "r-cancel", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    expect(cancelReminder(sql, "r-cancel", T0 - 10).cancelled).toBe(true);
    expect(claimDueReminders(sql, T0 + 1000, LEASE, "run-1")).toEqual([]);
    expect(getReminder(sql, "r-cancel")?.status).toBe("cancelled");
  });

  it("a claimed reminder is claimed once, cannot be cancelled, and is never sent twice", () => {
    const sql = openDb();
    createReminder(sql, { id: "r-claim", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    const claimed = claimDueReminders(sql, T0, LEASE, "run-1");
    expect(claimed.map((r) => r.id)).toEqual(["r-claim"]);
    expect(claimDueReminders(sql, T0 + 10, LEASE, "run-2")).toEqual([]);
    const cancel = cancelReminder(sql, "r-claim", T0 + 20);
    expect(cancel.cancelled).toBe(false);
    expect(cancel.reminder?.status).toBe("sending");
    expect(finishReminder(sql, "r-claim", "run-1", { kind: "sent" }, T0 + 30)).toBe(true);
    expect(claimDueReminders(sql, T0 + LEASE * 10, LEASE, "run-3")).toEqual([]);
    expect(getReminder(sql, "r-claim")?.status).toBe("sent");
  });

  it("a crashed claim is reclaimed after its lease, and the stale run cannot settle it", () => {
    const sql = openDb();
    createReminder(sql, { id: "r-lease", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1");
    expect(claimDueReminders(sql, T0 + LEASE - 1, LEASE, "run-2")).toEqual([]);
    expect(claimDueReminders(sql, T0 + LEASE, LEASE, "run-2").map((r) => r.id)).toEqual(["r-lease"]);
    expect(finishReminder(sql, "r-lease", "run-1", { kind: "sent" }, T0 + LEASE + 1)).toBe(false);
    expect(finishReminder(sql, "r-lease", "run-2", { kind: "sent" }, T0 + LEASE + 2)).toBe(true);
  });

  it("a retry goes back to waiting and is claimed again at its new time", () => {
    const sql = openDb();
    createReminder(sql, { id: "r-retry", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1");
    finishReminder(sql, "r-retry", "run-1", { kind: "retry", atMs: T0 + 30_000 }, T0 + 1);
    expect(claimDueReminders(sql, T0 + 29_999, LEASE, "run-2")).toEqual([]);
    expect(claimDueReminders(sql, T0 + 30_000, LEASE, "run-2")[0]?.attempts).toBe(2);
  });
});

describe("turn ledger", () => {
  it("keeps the first receive time through retries and completion", () => {
    const sql = openDb();
    const first = putTurnIfAbsent(sql, "turn-42", "2026-11-01T15:00:00.000Z");
    const retry = putTurnIfAbsent(sql, "turn-42", "2026-11-01T15:02:00.000Z");
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.turn.firstReceivedAt).toBe("2026-11-01T15:00:00.000Z");
    expect(completeTurn(sql, "turn-42", "2026-11-01T15:00:20.000Z")?.status).toBe("complete");
    expect(putTurnIfAbsent(sql, "turn-42", "2026-11-01T16:00:00.000Z").turn.firstReceivedAt).toBe("2026-11-01T15:00:00.000Z");
  });
});

describe("pending approval pointer", () => {
  it("reads as nothing under a different generation", () => {
    const sql = openDb();
    setPendingPointer(sql, "appr-1", 4, "2026-11-01T15:00:00.000Z");
    expect(getPendingPointer(sql, 4)?.approvalId).toBe("appr-1");
    expect(getPendingPointer(sql, 5)).toBeNull();
    expect(getPendingPointer(sql, 3)).toBeNull();
  });
});

describe("conversation delete", () => {
  it("removes everything and says exactly what it removed", () => {
    const sql = openDb();
    createReminder(sql, { id: "d-1", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    createReminder(sql, { id: "d-2", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    createReminder(sql, { id: "d-sent", text: "x", dueAtMs: T0, generation: 1 }, T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1");
    finishReminder(sql, "d-sent", "run-1", { kind: "sent" }, T0 + 1);
    putTurnIfAbsent(sql, "turn-1", "2026-11-01T15:00:00.000Z");
    putTurnIfAbsent(sql, "turn-2", "2026-11-01T15:01:00.000Z");
    setPendingPointer(sql, "appr-1", 1, "2026-11-01T15:00:00.000Z");
    sql.exec("INSERT INTO approvals VALUES ('appr-1', 'pending'), ('appr-2', 'approved')");
    sql.exec("INSERT INTO memory VALUES ('m-1', 'a'), ('m-2', 'b'), ('m-3', 'c')");

    const removed = removeConversationState(sql, T0 + 2);
    expect(removed).toEqual({
      remindersCancelled: 2,
      turnsDeleted: 2,
      pendingPointerCleared: true,
      approvalsRejected: 1,
      memoriesDeleted: 3,
    });
    expect(listReminders(sql).map((r) => [r.id, r.status])).toEqual([
      ["d-1", "cancelled"],
      ["d-2", "cancelled"],
      ["d-sent", "sent"],
    ]);
    // The in-flight claims' late results are ignored.
    expect(finishReminder(sql, "d-1", "run-1", { kind: "sent" }, T0 + 3)).toBe(false);
    expect(removeConversationState(sql, T0 + 4)).toEqual({
      remindersCancelled: 0,
      turnsDeleted: 0,
      pendingPointerCleared: false,
      approvalsRejected: 0,
      memoriesDeleted: 0,
    });
  });
});
