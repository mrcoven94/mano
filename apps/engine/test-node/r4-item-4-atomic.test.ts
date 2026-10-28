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
  fromAgentId: string,
  key: string,
  append: () => void,
) {
  return applyConsentDelivery(sql, fromAgentId, key, append, (fn) => nodeTransact(sql, fn));
}

describe("r4 item 4: delivery marker and event are atomic", () => {
  it("documents the hole: a marker alone reads as done", () => {
    const sql = openOrgTables();
    // The crash state: marker written, event never appended.
    expect(tryRecordDelivery(sql, "person:r4i4", "key-crash")).toBe("recorded");
    expect(count(sql, "case_events")).toBe(0);
    // The old reconcile read the marker: one row means done.
    const marker = sql.exec("SELECT idempotency_key FROM processed_messages WHERE sender_agent_id = ? AND idempotency_key = ?", "person:r4i4", "key-crash").toArray();
    expect(marker.length).toBe(1);
    // The event record tells the truth: nothing happened.
    expect(consentEventRecorded(sql, "key-crash")).toBe(false);
  });

  it("applies the missing event when only the marker survived", () => {
    const sql = openOrgTables();
    sql.exec("INSERT INTO processed_messages VALUES (?, ?)", "person:r4i4", "key-retry");
    const out = apply(sql, "person:r4i4", "key-retry", () => {
      sql.exec(
        "INSERT INTO case_events(case_id, event, person_id, purpose, message_id, at, idempotency_key) VALUES (?,?,?,?,?,?,?)",
        "case-r4i4", "revoke", "r4i4", "", "msg-1", new Date().toISOString(), "key-retry",
      );
    });
    expect(out).toBe("applied");
    expect(consentEventRecorded(sql, "key-retry")).toBe(true);
    expect(count(sql, "case_events")).toBe(1);
  });

  it("reports a genuine duplicate only when the event exists", () => {
    const sql = openOrgTables();
    const append = () => {
      sql.exec(
        "INSERT INTO case_events(case_id, event, person_id, purpose, message_id, at, idempotency_key) VALUES (?,?,?,?,?,?,?)",
        "case-r4i4", "revoke", "r4i4", "", "msg-1", new Date().toISOString(), "key-dup",
      );
    };
    expect(apply(sql, "person:r4i4", "key-dup", append)).toBe("applied");
    expect(apply(sql, "person:r4i4", "key-dup", append)).toBe("duplicate");
    expect(count(sql, "case_events")).toBe(1);
  });

  it("rolls the marker back when the append fails", () => {
    const sql = openOrgTables();
    const out = apply(sql, "person:r4i4", "key-fail", () => {
      throw new Error("storage exploded mid-write");
    });
    expect(out).toBe("unavailable");
    expect(count(sql, "processed_messages")).toBe(0);
    // A later retry starts clean.
    expect(apply(sql, "person:r4i4", "key-fail", () => {
      sql.exec(
        "INSERT INTO case_events(case_id, event, person_id, purpose, message_id, at, idempotency_key) VALUES (?,?,?,?,?,?,?)",
        "case-r4i4", "revoke", "r4i4", "", "msg-2", new Date().toISOString(), "key-fail",
      );
    })).toBe("applied");
  });
});
