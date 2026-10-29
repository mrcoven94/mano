/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { TimeoutError } from "../src/gateway/types.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// Round 6, item 3: the round 5 recovery case against the real SQLite
// store, so the guarded claim in SQL is what decides. The window lapses
// while recovery's checker runs; the claim must refuse to execute.

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

describe("r6 item 3: SQL recovery claim never executes past expiry", () => {
  it("does not execute when the window lapses during recovery checks", async () => {
    const storage = openTestStorage();
    ensureGatewayTables(storage as never);
    const store = new SqlApprovalStore(storage as never);
    const calls: ActionRequest[] = [];
    const exec: Executor = {
      simulated: true,
      async execute(req) {
        calls.push(req);
        throw new TimeoutError();
      },
      async check() {
        return { found: false as const };
      },
    };
    const gw = new ActionGateway(store, exec, {
      checker: {
        async check() {
          await new Promise((r) => setTimeout(r, 150));
          return { verdict: "pass", problems: [] };
        },
      },
    });
    const key = "r6i3-lapse";
    const req: ActionRequest = {
      type: "submit",
      recipient: "sandbox-agency",
      purpose: "renewal",
      payload: {},
      idempotencyKey: key,
      actor: "foreground",
      personId: "maria",
      sources: [],
      origin: "person",
    };
    const pending = await gw.requestAction(req);
    expect(pending.status).toBe("needs_approval");
    const first = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(calls.length).toBe(1);

    // The window ends 50ms from now; recovery's checker still runs past it.
    const approval = store.getApproval(pending.approval!.id)!;
    store.putApproval({ ...approval, expiresAt: new Date(Date.now() + 50).toISOString() });

    const recovered = await gw.recoverAttempt(key, new Date(), new Date(Date.now() + 3600_000).toISOString());
    expect(recovered?.status).toBe("blocked");
    expect(recovered?.reason).toMatch(/expired/i);
    expect(calls.length).toBe(1);
    expect(store.getAttempt(key)?.status).toBe("failed");
  });
});
