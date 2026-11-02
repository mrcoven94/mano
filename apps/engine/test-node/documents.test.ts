/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureAgentStateTables, removeConversationState } from "../src/agents/agent-state.js";
import { ensureGatewayTables } from "../src/gateway/sql-store.js";
import { ensureDocumentTables, listDocuments as listWith, recordDocument } from "../src/documents.js";
import { createExecutor } from "../src/gateway/executors.js";

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

// The executor a simulated Engine runs, with its default portal limits.
const simulated = createExecutor({ EXECUTOR_MODE: "simulated" });
const listDocuments = (sql: ReturnType<typeof openDb>, timeZone: string) => listWith(sql, timeZone, simulated);

const doc = (id: string, receivedAt: string, generation: number, sizeBytes = 2048, mediaType: "image/jpeg" | "image/png" | "application/pdf" | null = "image/jpeg") => ({
  id,
  name: id,
  hash: "0".repeat(64),
  r2Key: `persons/p/docs/g${generation}/${id}`,
  mediaType,
  sizeBytes,
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
        sizeBytes: 2048,
        filing: "fileable",
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

  it("says whether the configured executor could file each document, by its kind and its size", () => {
    const sql = openDb();
    ensureGatewayTables(sql as never);
    ensureAgentStateTables(sql);
    ensureDocumentTables(sql);
    const fiveMiB = 5 * 1024 * 1024;
    recordDocument(sql, doc("g0t1i0-fits", "2026-11-02T18:00:00.000Z", 0, fiveMiB, "application/pdf"));
    recordDocument(sql, doc("g0t2i0-big", "2026-11-02T18:01:00.000Z", 0, fiveMiB + 1, "image/png"));
    recordDocument(sql, doc("g0t3i0-heic", "2026-11-02T18:02:00.000Z", 0, 2048, null));
    expect(listDocuments(sql, "UTC").map((d) => [d.id, d.sizeBytes, d.filing])).toEqual([
      ["g0t3i0-heic", 2048, "wrong_type"],
      ["g0t2i0-big", fiveMiB + 1, "too_large"],
      ["g0t1i0-fits", fiveMiB, "fileable"],
    ]);
  });

  it("takes the size limit from Engine's SANDBOX_MAX_UPLOAD_BYTES, in sandbox and simulated modes alike", () => {
    const sql = openDb();
    ensureGatewayTables(sql as never);
    ensureAgentStateTables(sql);
    ensureDocumentTables(sql);
    recordDocument(sql, doc("g0t1i0-photo", "2026-11-02T18:00:00.000Z", 0, 2048));
    const filing = (env: Record<string, string>) => listWith(sql, "UTC", createExecutor(env))[0]!.filing;
    expect(filing({ EXECUTOR_MODE: "simulated" })).toBe("fileable");
    expect(filing({ EXECUTOR_MODE: "simulated", SANDBOX_MAX_UPLOAD_BYTES: "2047" })).toBe("too_large");
    const sandbox = { EXECUTOR_MODE: "sandbox", SANDBOX_BASE_URL: "https://portal.test", SANDBOX_PORTAL_TOKEN: "t" };
    expect(filing(sandbox)).toBe("fileable");
    expect(filing({ ...sandbox, SANDBOX_MAX_UPLOAD_BYTES: "2048" })).toBe("fileable");
    expect(filing({ ...sandbox, SANDBOX_MAX_UPLOAD_BYTES: "2047" })).toBe("too_large");
  });

  it("lists a document stored before sizes were recorded as size unknown, which is not fileable", () => {
    const sql = openDb();
    ensureGatewayTables(sql as never);
    ensureAgentStateTables(sql);
    for (const column of ["received_at TEXT", "generation INTEGER", "kind TEXT", "media_type TEXT"]) {
      sql.exec(`ALTER TABLE documents ADD COLUMN ${column}`);
    }
    sql.exec("INSERT INTO documents(id, name, hash, r2_key, received_at, generation, media_type) VALUES ('g0t1i0-older', 'older', 'h', 'k', '2026-11-02T18:00:00.000Z', 0, 'image/png')");
    ensureDocumentTables(sql);
    expect(listDocuments(sql, "UTC").map((d) => [d.id, d.sizeBytes, d.filing])).toEqual([["g0t1i0-older", null, "size_unknown"]]);
  });
});
