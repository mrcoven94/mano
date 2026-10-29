/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// Round 5, item 3 against real SQLite, tightened in round 7: the
// persisted audit_log row for a blocked URL carries only its SHA-256.
// No part of the URL, the synthetic sentinel included, appears in the row.

function openTestStorage() {
  const db = new DatabaseSync(":memory:");
  return {
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
}

describe("r5 item 3: persisted audit rows redact blocked URLs", () => {
  it("stores no part of the URL in audit_log", async () => {
    const storage = openTestStorage();
    ensureGatewayTables(storage as never);
    const store = new SqlApprovalStore(storage as never);
    const exec: Executor = {
      simulated: true,
      async execute() {
        throw new Error("Must not execute: the link check blocks first.");
      },
      async check() {
        return { found: false as const };
      },
    };
    const gw = new ActionGateway(store, exec, {
      linkCheck: async () => ({ allowed: false, reason: "Blocked domain." }),
    });
    const sentinel = "Sentinel-Victim-7ZQ";
    const req: ActionRequest = {
      type: "send",
      recipient: "sandbox-agency",
      purpose: "notice",
      payload: { url: `https://portal.example.com/renewal/form?case=${sentinel}&tag=x` },
      idempotencyKey: "r5i3-persist-1",
      actor: "foreground",
      personId: "maria",
      sources: [],
      origin: "person",
    };
    const result = await gw.requestAction(req);
    expect(result.status).toBe("blocked");

    const rows = storage.exec("SELECT detail FROM audit_log WHERE event = 'gateway.link_block'").toArray() as {
      detail: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0].detail).not.toContain(sentinel);
    expect(rows[0].detail).not.toContain("portal.example.com");
    expect(rows[0].detail).not.toContain("/renewal/form");
    expect(JSON.parse(rows[0].detail).urlHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
