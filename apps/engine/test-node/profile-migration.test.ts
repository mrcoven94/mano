/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureAgentStateTables, removeConversationState } from "../src/agents/agent-state.js";
import { ensureGatewayTables } from "../src/gateway/sql-store.js";
import { ProfileStore, type FieldCipher } from "../src/profile.js";

// The one-time move from memory against a delete that lands while the
// migration is sealing values: nothing comes back.

function openDb() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const head = query.trimStart().toUpperCase();
      if (head.startsWith("SELECT") || head.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureGatewayTables(sql as never);
  ensureAgentStateTables(sql);
  sql.exec("CREATE TABLE memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0)");
  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  return { sql, transaction };
}

function storeWith(db: ReturnType<typeof openDb>, onSeal: () => void): ProfileStore {
  const cipher: FieldCipher = {
    seal: async (path, plaintext) => {
      onSeal();
      await Promise.resolve();
      return JSON.stringify([path, plaintext]);
    },
    open: async (_path, sealed) => (JSON.parse(sealed) as [string, string])[1],
  };
  return new ProfileStore({ sql: db.sql, transaction: db.transaction, cipher, now: () => new Date(), documentExists: () => false });
}

describe("migration from memory", () => {
  it("a conversation delete that lands mid-migration is never undone", async () => {
    const db = openDb();
    db.sql.exec("INSERT INTO memory(id, content, source, created_at) VALUES ('n1', 'Lives in Synthetic County', 'agent', '2026-10-29T00:00:00Z')");
    let deleted = false;
    const store = storeWith(db, () => {
      if (!deleted) {
        deleted = true;
        db.transaction(() => removeConversationState(db.sql, Date.now(), 1));
      }
    });
    const profile = await store.read();
    expect(deleted).toBe(true);
    expect(profile.person.county).toBeUndefined();
    expect(db.sql.exec("SELECT * FROM profile_fields").toArray()).toEqual([]);
    expect(db.sql.exec("SELECT * FROM memory").toArray()).toEqual([]);
  });

  it("a note forgotten mid-migration is not moved", async () => {
    const db = openDb();
    db.sql.exec("INSERT INTO memory(id, content, source, created_at) VALUES ('n1', 'Lives in Synthetic County', 'agent', '2026-10-29T00:00:00Z')");
    db.sql.exec("INSERT INTO memory(id, content, source, created_at) VALUES ('n2', 'Prefers Spanish', 'agent', '2026-10-29T00:00:01Z')");
    let forgot = false;
    const store = storeWith(db, () => {
      if (!forgot) {
        forgot = true;
        db.sql.exec("DELETE FROM memory WHERE id = 'n1'");
      }
    });
    const profile = await store.read();
    expect(profile.person.county).toBeUndefined();
    // The next read starts over from what memory now holds.
    expect(profile.person.language).toMatchObject({ value: "Spanish", source: "agent" });
  });
});
