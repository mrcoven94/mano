/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyConsentDelivery, consentEventRecorded, tryRecordDelivery } from "../src/consent-dedupe.js";

// Round 4, item 4 against real SQLite: the delivery marker and the
// consent event are written in one transaction, and reconcile reads the
// event record, not the marker. A crash between the two writes is
// simulated by seeding a marker row with no event, the exact post-crash
// state; a retry must then apply the missing event, not report done.

function openOrgTables() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      if (trimmed.startsWith("INSERT") && trimmed.includes("RETURNING")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: rows.length };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  sql.exec(`CREATE TABLE processed_messages(sender_agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY (sender_agent_id, idempotency_key))`);
  sql.exec(`CREATE TABLE case_events(id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, event TEXT NOT NULL, person_id TEXT NOT NULL, purpose TEXT NOT NULL, message_id TEXT NOT NULL, at TEXT NOT NULL, idempotency_key TEXT)`);
  return sql;
}

function count(sql: ReturnType<typeof openOrgTables>, table: string): number {
  return (sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray() as { n: number }[])[0].n;
}

// Stands in for Durable Object transactionSync, which node:sqlite has
// no equivalent of: BEGIN/COMMIT around the closure, ROLLBACK on throw.
function nodeTransact<T>(sql: ReturnType<typeof openOrgTables>, fn: () => T): T {
  sql.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    sql.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      sql.exec("ROLLBACK");
    } catch {
      // Nothing to roll back; the original error carries the outcome.
    }
    throw err;
  }
}

function apply(
  sql: ReturnType<typeof openOrgTables>,
  scope: { fromAgentId: string; idempotencyKey: string; event: "share" | "revoke" },
  append: () => void,
) {
  return applyConsentDelivery(sql, scope, append, (fn) => nodeTransact(sql, fn));
}

function appendEvent(
  sql: ReturnType<typeof openOrgTables>,
  o: { caseId: string; event: "share" | "revoke"; person: string; messageId: string; key: string },
) {
  sql.exec(
    "INSERT INTO case_events(case_id, event, person_id, purpose, message_id, at, idempotency_key) VALUES (?,?,?,?,?,?,?)",
    o.caseId, o.event, o.person, "", o.messageId, new Date().toISOString(), o.key,
  );
}

describe("r4 item 4: delivery marker and event are atomic", () => {
  it("documents the hole: a marker alone reads as done", () => {
    const sql = openOrgTables();
    const scope = { fromAgentId: "person:r4i4", idempotencyKey: "key-crash", event: "revoke" as const };
    // The crash state: marker written, event never appended.
    expect(tryRecordDelivery(sql, "person:r4i4", "key-crash")).toBe("recorded");
    expect(count(sql, "case_events")).toBe(0);
    // The old reconcile read the marker: one row means done.
    const marker = sql.exec("SELECT idempotency_key FROM processed_messages WHERE sender_agent_id = ? AND idempotency_key = ?", "person:r4i4", "key-crash").toArray();
    expect(marker.length).toBe(1);
    // The event record tells the truth: nothing happened.
    expect(consentEventRecorded(sql, scope)).toBe(false);
  });

  it("applies the missing event when only the marker survived", () => {
    const sql = openOrgTables();
    const scope = { fromAgentId: "person:r4i4", idempotencyKey: "key-retry", event: "revoke" as const };
    sql.exec("INSERT INTO processed_messages VALUES (?, ?)", "person:r4i4", "key-retry");
    const out = apply(sql, scope, () => {
      appendEvent(sql, { caseId: "case-r4i4", event: "revoke", person: "r4i4", messageId: "msg-1", key: "key-retry" });
    });
    expect(out).toBe("applied");
    expect(consentEventRecorded(sql, scope)).toBe(true);
    expect(count(sql, "case_events")).toBe(1);
  });

  it("reports a genuine duplicate only when the event exists", () => {
    const sql = openOrgTables();
    const scope = { fromAgentId: "person:r4i4", idempotencyKey: "key-dup", event: "revoke" as const };
    const append = () => {
      appendEvent(sql, { caseId: "case-r4i4", event: "revoke", person: "r4i4", messageId: "msg-1", key: "key-dup" });
    };
    expect(apply(sql, scope, append)).toBe("applied");
    expect(apply(sql, scope, append)).toBe("duplicate");
    expect(count(sql, "case_events")).toBe(1);
  });

  it("rolls the marker back when the append fails", () => {
    const sql = openOrgTables();
    const scope = { fromAgentId: "person:r4i4", idempotencyKey: "key-fail", event: "revoke" as const };
    const out = apply(sql, scope, () => {
      throw new Error("storage exploded mid-write");
    });
    expect(out).toBe("unavailable");
    expect(count(sql, "processed_messages")).toBe(0);
    // A later retry starts clean.
    expect(apply(sql, scope, () => {
      appendEvent(sql, { caseId: "case-r4i4", event: "revoke", person: "r4i4", messageId: "msg-2", key: "key-fail" });
    })).toBe("applied");
  });

  it("keeps two senders under one key apart", () => {
    const sql = openOrgTables();
    const eve = { fromAgentId: "person:eve", idempotencyKey: "key-shared", event: "share" as const };
    const alice = { fromAgentId: "person:alice", idempotencyKey: "key-shared", event: "revoke" as const };
    expect(apply(sql, eve, () => {
      appendEvent(sql, { caseId: "case-eve", event: "share", person: "eve", messageId: "msg-e1", key: "key-shared" });
    })).toBe("applied");
    // Eve's delivery must not satisfy Alice's reconcile, and a grant
    // must not satisfy a revoke consult, even under the same key.
    expect(consentEventRecorded(sql, alice)).toBe(false);
    expect(consentEventRecorded(sql, { ...eve, event: "revoke" })).toBe(false);
    expect(consentEventRecorded(sql, eve)).toBe(true);
    // Alice's own action still applies beside it, not as its duplicate.
    expect(apply(sql, alice, () => {
      appendEvent(sql, { caseId: "case-alice", event: "revoke", person: "alice", messageId: "msg-a1", key: "key-shared" });
    })).toBe("applied");
    expect(consentEventRecorded(sql, alice)).toBe(true);
    expect(count(sql, "case_events")).toBe(2);
  });
});
