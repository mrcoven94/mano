/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  cancelReminder,
  claimDueReminders,
  completeTurn,
  createReminder,
  currentGeneration,
  ensureAgentStateTables,
  finishReminder,
  getPendingPointer,
  getReminder,
  handOffReminder,
  listReminders,
  putTurnIfAbsent,
  removeConversationState,
  setPendingPointer,
} from "../src/agents/agent-state.js";
import { ensureGatewayTables } from "../src/gateway/sql-store.js";

// The agent's per-person state on real SQLite: atomic claim, handoff and
// cancel, one reminder per identity, the generation fence on every write,
// generation-checked pointer reads, the turn ledger, and delete-all.

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
  ensureGatewayTables(sql as never);
  ensureAgentStateTables(sql);
  sql.exec("CREATE TABLE memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0)");
  return sql;
}

function approvalRow(sql: ReturnType<typeof openDb>, id: string, status: string, key: string, generation = 0) {
  sql.exec(
    "INSERT INTO approvals(id, action_type, recipient, purpose, idempotency_key, status, created_at, remind_at, expires_at," +
      " escalated, person_id, request_json, request_hash, problems_json, generation) VALUES (?, 'submit', 'x', 'p', ?, ?, '', '', '', 0, 'p', '{}', 'h', '[]', ?)",
    id, key, status, generation,
  );
}

const T0 = Date.parse("2026-11-01T15:00:00Z");
const LEASE = 60_000;
const BATCH = 25;
const reminder = (id: string, generation = 0) => ({ id, text: "x", dueAtMs: T0, generation });

describe("reminders", () => {
  it("one identity is one reminder; two identities at the same time stay two", () => {
    const sql = openDb();
    const first = createReminder(sql, { ...reminder("turn-7:0"), text: "Call the county" }, T0 - 1000);
    const again = createReminder(sql, { ...reminder("turn-7:0"), text: "Call the county" }, T0 - 500);
    const other = createReminder(sql, { ...reminder("turn-7:1"), text: "Call the county" }, T0 - 500);
    expect("created" in first && first.created).toBe(true);
    expect("created" in again && again.created).toBe(false);
    expect("created" in other && other.created).toBe(true);
    expect(listReminders(sql).map((r) => r.id)).toEqual(["turn-7:0", "turn-7:1"]);
    const changed = createReminder(sql, { ...reminder("turn-7:0"), text: "Something else" }, T0);
    expect("conflict" in changed).toBe(true);
    expect(getReminder(sql, "turn-7:0")?.text).toBe("Call the county");
  });

  it("a cancelled reminder is never claimed", () => {
    const sql = openDb();
    createReminder(sql, reminder("r-cancel"), T0 - 1000);
    expect(cancelReminder(sql, "r-cancel", T0 - 10).cancelled).toBe(true);
    expect(claimDueReminders(sql, T0 + 1000, LEASE, "run-1", BATCH)).toEqual([]);
    expect(getReminder(sql, "r-cancel")?.status).toBe("cancelled");
  });

  it("a claim not yet handed off can be cancelled, and then never hands off", () => {
    const sql = openDb();
    createReminder(sql, reminder("r-claimed"), T0 - 1000);
    expect(claimDueReminders(sql, T0, LEASE, "run-1", BATCH).map((r) => r.id)).toEqual(["r-claimed"]);
    expect(cancelReminder(sql, "r-claimed", T0 + 1).cancelled).toBe(true);
    expect(handOffReminder(sql, "r-claimed", "run-1", T0 + 2)).toBe(false);
    expect(getReminder(sql, "r-claimed")?.status).toBe("cancelled");
  });

  it("a handed-off reminder reports sending, is claimed once and settles once", () => {
    const sql = openDb();
    createReminder(sql, reminder("r-claim"), T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1", BATCH);
    expect(claimDueReminders(sql, T0 + 10, LEASE, "run-2", BATCH)).toEqual([]);
    expect(handOffReminder(sql, "r-claim", "run-1", T0 + 15)).toBe(true);
    const cancel = cancelReminder(sql, "r-claim", T0 + 20);
    expect(cancel.cancelled).toBe(false);
    expect(cancel.reminder?.status).toBe("sending");
    expect(finishReminder(sql, "r-claim", "run-1", { kind: "sent" }, T0 + 30)).toBe(true);
    expect(claimDueReminders(sql, T0 + LEASE * 10, LEASE, "run-3", BATCH)).toEqual([]);
    expect(getReminder(sql, "r-claim")?.status).toBe("sent");
  });

  it("the handoff re-checks the generation: a claim from a deleted conversation is dropped", () => {
    const sql = openDb();
    createReminder(sql, reminder("r-a"), T0 - 1000);
    createReminder(sql, reminder("r-b"), T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1", BATCH);
    expect(handOffReminder(sql, "r-a", "run-1", T0 + 1)).toBe(true);
    // The conversation moves on while r-a is with Channels, as if a
    // delete landed between the two sends.
    sql.exec("UPDATE conversation_state SET generation = generation + 1 WHERE slot = 1");
    expect(handOffReminder(sql, "r-b", "run-1", T0 + 2)).toBe(false);
    expect(getReminder(sql, "r-b")?.status).toBe("dropped");
  });

  it("a crashed claim is reclaimed after its lease, and the stale run cannot settle it", () => {
    const sql = openDb();
    createReminder(sql, reminder("r-lease"), T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1", BATCH);
    handOffReminder(sql, "r-lease", "run-1", T0);
    expect(claimDueReminders(sql, T0 + LEASE - 1, LEASE, "run-2", BATCH)).toEqual([]);
    expect(claimDueReminders(sql, T0 + LEASE, LEASE, "run-2", BATCH).map((r) => r.id)).toEqual(["r-lease"]);
    expect(finishReminder(sql, "r-lease", "run-1", { kind: "sent" }, T0 + LEASE + 1)).toBe(false);
    handOffReminder(sql, "r-lease", "run-2", T0 + LEASE + 1);
    expect(finishReminder(sql, "r-lease", "run-2", { kind: "sent" }, T0 + LEASE + 2)).toBe(true);
  });

  it("a retry goes back to waiting and is claimed again at its new time", () => {
    const sql = openDb();
    createReminder(sql, reminder("r-retry"), T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1", BATCH);
    handOffReminder(sql, "r-retry", "run-1", T0);
    finishReminder(sql, "r-retry", "run-1", { kind: "retry", atMs: T0 + 30_000 }, T0 + 1);
    expect(claimDueReminders(sql, T0 + 29_999, LEASE, "run-2", BATCH)).toEqual([]);
    expect(claimDueReminders(sql, T0 + 30_000, LEASE, "run-2", BATCH)[0]?.attempts).toBe(2);
  });

  it("claims in bounded batches, earliest first, through an index", () => {
    const sql = openDb();
    for (let i = 0; i < 30; i++) createReminder(sql, { ...reminder(`b-${String(i).padStart(2, "0")}`), dueAtMs: T0 - i }, T0 - 1000);
    const first = claimDueReminders(sql, T0, LEASE, "run-1", BATCH);
    expect(first.length).toBe(25);
    expect(claimDueReminders(sql, T0, LEASE, "run-2", BATCH).length).toBe(5);
    const indexes = sql.exec("PRAGMA index_list(reminders)").toArray() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("reminders_due");
  });
});

describe("generation fence", () => {
  it("refuses a reminder, turn, completion or pointer prepared under an older generation", () => {
    const sql = openDb();
    approvalRow(sql, "appr-old", "pending", "k-old", 0);
    putTurnIfAbsent(sql, "turn-old", "2026-11-01T15:00:00.000Z", 0);
    removeConversationState(sql, T0);
    expect(currentGeneration(sql)).toBe(1);
    expect(createReminder(sql, reminder("late", 0), T0)).toEqual({ stale: true });
    expect(putTurnIfAbsent(sql, "turn-late", "2026-11-01T15:00:00.000Z", 0)).toEqual({ stale: true });
    expect(completeTurn(sql, "turn-old", "2026-11-01T15:00:01.000Z", 0)).toEqual({ stale: true });
    expect(setPendingPointer(sql, "appr-old", 1, "2026-11-01T15:00:00.000Z")).toBeNull();
    expect(listReminders(sql)).toEqual([]);
    expect("created" in createReminder(sql, reminder("fresh", 1), T0)).toBe(true);
  });
});

describe("turn ledger", () => {
  it("keeps the first receive time through retries and completion", () => {
    const sql = openDb();
    const first = putTurnIfAbsent(sql, "turn-42", "2026-11-01T15:00:00.000Z", 0);
    const retry = putTurnIfAbsent(sql, "turn-42", "2026-11-01T15:02:00.000Z", 0);
    expect("created" in first && first.created).toBe(true);
    expect("turn" in retry && retry.turn.firstReceivedAt).toBe("2026-11-01T15:00:00.000Z");
    const done = completeTurn(sql, "turn-42", "2026-11-01T15:00:20.000Z", 0);
    expect(done && "status" in done && done.status).toBe("complete");
    const later = putTurnIfAbsent(sql, "turn-42", "2026-11-01T16:00:00.000Z", 0);
    expect("turn" in later && later.turn.firstReceivedAt).toBe("2026-11-01T15:00:00.000Z");
  });
});

describe("pending approval pointer", () => {
  it("reads as nothing under a different generation", () => {
    const sql = openDb();
    approvalRow(sql, "appr-1", "pending", "k-1", 0);
    expect(setPendingPointer(sql, "appr-1", 0, "2026-11-01T15:00:00.000Z")?.approvalId).toBe("appr-1");
    expect(getPendingPointer(sql, 0)?.approvalId).toBe("appr-1");
    expect(getPendingPointer(sql, 1)).toBeNull();
  });
});

describe("conversation delete", () => {
  it("advances the generation, removes everything, revokes unresolved approvals, and counts exactly", () => {
    const sql = openDb();
    createReminder(sql, reminder("d-1"), T0 - 1000);
    createReminder(sql, reminder("d-2"), T0 - 1000);
    createReminder(sql, reminder("d-flight"), T0 - 1000);
    createReminder(sql, reminder("d-sent"), T0 - 1000);
    claimDueReminders(sql, T0, LEASE, "run-1", BATCH);
    handOffReminder(sql, "d-flight", "run-1", T0);
    handOffReminder(sql, "d-sent", "run-1", T0);
    finishReminder(sql, "d-sent", "run-1", { kind: "sent" }, T0 + 1);
    putTurnIfAbsent(sql, "turn-1", "2026-11-01T15:00:00.000Z", 0);
    putTurnIfAbsent(sql, "turn-2", "2026-11-01T15:01:00.000Z", 0);
    approvalRow(sql, "appr-pending", "pending", "k-p");
    approvalRow(sql, "appr-unresolved", "approved", "k-u");
    approvalRow(sql, "appr-done", "approved", "k-d");
    sql.exec("INSERT INTO attempts(idempotency_key, status, updated_at) VALUES ('k-u', 'unknown', ''), ('k-d', 'done', '')");
    setPendingPointer(sql, "appr-pending", 0, "2026-11-01T15:00:00.000Z");
    sql.exec("INSERT INTO memory(id, content) VALUES ('m-1', 'a'), ('m-2', 'b'), ('m-3', 'c')");

    expect(removeConversationState(sql, T0 + 2, 4)).toEqual({
      generation: 4,
      remindersCancelled: 2,
      remindersInFlight: 1,
      turnsDeleted: 2,
      pendingPointerCleared: true,
      approvalsRejected: 1,
      approvalsRevoked: 1,
      memoriesDeleted: 3,
    });
    const statuses = Object.fromEntries(listReminders(sql).map((r) => [r.id, r.status]));
    expect(statuses).toEqual({ "d-1": "cancelled", "d-2": "cancelled", "d-flight": "sending", "d-sent": "sent" });
    const approvals = sql.exec("SELECT id, status FROM approvals ORDER BY id").toArray();
    expect(approvals).toEqual([
      { id: "appr-done", status: "approved" },
      { id: "appr-pending", status: "rejected" },
      { id: "appr-unresolved", status: "revoked" },
    ]);
    expect(finishReminder(sql, "d-1", "run-1", { kind: "sent" }, T0 + 3)).toBe(false);
    expect(removeConversationState(sql, T0 + 4)).toEqual({
      generation: 5,
      remindersCancelled: 0,
      remindersInFlight: 1,
      turnsDeleted: 0,
      pendingPointerCleared: false,
      approvalsRejected: 0,
      approvalsRevoked: 0,
      memoriesDeleted: 0,
    });
  });
});
