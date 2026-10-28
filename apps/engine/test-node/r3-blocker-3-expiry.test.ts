/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { InMemoryExecutor } from "../src/gateway/executors.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import type { ActionRequest } from "../src/gateway/types.js";

// Round 3, blocker 3 against the real SQLite store: the guarded claim
// reads a fresh clock, so an approval expiring mid-approve cannot execute.

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

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r3b3n-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r3 blocker 3: fresh clock in the SQL claim", () => {
  it("blocks when the window lapses during the checker run", async () => {
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    const store = new SqlApprovalStore(storage);
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(store, exec, {
      checker: {
        async check() {
          await new Promise((r) => setTimeout(r, 150));
          return { verdict: "pass", problems: [] };
        },
      },
    });
    const first = await gw.requestAction(baseReq());
    expect(first.status).toBe("needs_approval");
    const approval = store.getApproval(first.approval!.id)!;
    store.putApproval({ ...approval, expiresAt: new Date(Date.now() + 30).toISOString() });

    const result = await gw.approveAndExecute(first.approval!.id, "maria");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/expired/i);
    expect(exec.calls.length).toBe(0);
  });
});
