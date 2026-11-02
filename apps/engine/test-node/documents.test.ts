/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureAgentStateTables, removeConversationState } from "../src/agents/agent-state.js";
import { ensureGatewayTables } from "../src/gateway/sql-store.js";
import { ensureDocumentTables, listDocuments, recordDocument } from "../src/documents.js";

// The documents table as an Engine deployed before the list finds it:
// rows with no receive time or generation. The columns are added in
// place, and the list shows only documents recorded with both.

function openDb() {
  const db = new DatabaseSync(":memory:");
  return {
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
}

const doc = (id: string, receivedAt: string, generation: number) => ({
  id,
  name: id,
  hash: "0".repeat(64),
  r2Key: `persons/p/docs/g${generation}/${id}`,
  mediaType: "image/jpeg" as const,
  receivedAt,
  generation,
});

describe("the documents table", () => {
  it("adds its columns to an older table once, and lists only documents recorded with a receive time", () => {
    const sql = openDb();
    ensureGatewayTables(sql as never);
    ensureAgentStateTables(sql);
    sql.exec("INSERT INTO documents(id, name, hash, r2_key) VALUES ('legacy', 'legacy', 'h', 'k')");
    ensureDocumentTables(sql);
    ensureDocumentTables(sql);
    expect(listDocuments(sql, "America/Los_Angeles")).toEqual([]);

    expect(recordDocument(sql, doc("g0t1i0-new", "2026-11-02T18:00:00.000Z", 0))).toBe(true);
    expect(listDocuments(sql, "America/Los_Angeles")).toEqual([
      {
        id: "g0t1i0-new",
        kind: null,
        mediaType: "image/jpeg",
        receivedAt: "2026-11-02T18:00:00.000Z",
        label: "the photo you sent on November 2",
        generation: 0,
      },
    ]);
  });

  it("names the day in the person's own time zone", () => {
    const sql = openDb();
    ensureGatewayTables(sql as never);
    ensureAgentStateTables(sql);
    ensureDocumentTables(sql);
    // 7:30 PM in Los Angeles on November 2 is already November 3 in UTC.
    recordDocument(sql, doc("g0t1i0-evening", "2026-11-03T03:30:00.000Z", 0));
    expect(listDocuments(sql, "America/Los_Angeles")[0]!.label).toBe("the photo you sent on November 2");
    expect(listDocuments(sql, "America/New_York")[0]!.label).toBe("the photo you sent on November 2");
    expect(listDocuments(sql, "UTC")[0]!.label).toBe("the photo you sent on November 3");
  });

  it("records nothing under a generation a delete moved past", () => {
    const sql = openDb();
    ensureGatewayTables(sql as never);
    ensureAgentStateTables(sql);
    ensureDocumentTables(sql);
    sql.exec("CREATE TABLE memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)");
    removeConversationState(sql, Date.now(), 1);
    expect(recordDocument(sql, doc("g0t1i0-late", "2026-11-02T18:00:00.000Z", 0))).toBe(false);
    expect(recordDocument(sql, doc("g1t1i0-now", "2026-11-02T18:00:00.000Z", 1))).toBe(true);
    expect(listDocuments(sql, "UTC").map((d) => d.id)).toEqual(["g1t1i0-now"]);
  });
});
