/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { tryRecordDelivery } from "../src/consent-dedupe.js";

// Round 3, blocker 7 against real SQLite: only a genuine duplicate key
// conflict counts as a duplicate delivery. Any other storage error is
// unavailable and must throw, never read as success.

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE processed_messages(sender_agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY (sender_agent_id, idempotency_key))",
  );
  return {
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
}

describe("r3 blocker 7: only real duplicates succeed", () => {
  it("records once, then reports the genuine duplicate", () => {
    const sql = openDb() as never;
    expect(tryRecordDelivery(sql, "person:maria", "key-1")).toBe("recorded");
    expect(tryRecordDelivery(sql, "person:maria", "key-1")).toBe("duplicate");
    expect(tryRecordDelivery(sql, "person:maria", "key-2")).toBe("recorded");
    expect(tryRecordDelivery(sql, "person:eve", "key-1")).toBe("recorded");
  });

  it("throws genuine storage errors instead of calling them duplicates", () => {
    const db = new DatabaseSync(":memory:");
    const missing = {
      exec(query: string, ...bindings: unknown[]) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      },
    } as never;
    // Real SQLite error, no such table: thrown through, never a duplicate.
    expect(() => tryRecordDelivery(missing, "person:maria", "key-1")).toThrow(/no such table/);
    db.close();
  });
});
