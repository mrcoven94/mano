/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { InMemoryExecutor } from "../src/gateway/executors.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { TimeoutError } from "../src/gateway/types.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// Round 3, blocker 4 against the real SQLite store: reconciling never
// completes a different action. Content is checked before reconciling,
// and receipts come from the persisted original attempt.

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
    idempotencyKey: `r3b4n-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r3 blocker 4: reconcile keeps the original action", () => {
  it("rejects a different action reusing an unknown key instead of reconciling it", async () => {
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    const store = new SqlApprovalStore(storage);
    const calls: ActionRequest[] = [];
    let checks = 0;
    const flaky: Executor = {
      simulated: true,
      async execute(req) {
        calls.push(req);
        throw new TimeoutError();
      },
      async check() {
        checks += 1;
        // Absent right after the timeout, found by the time anyone asks
        // again: the outside system did record the first action.
        return checks === 1 ? { found: false as const } : { found: true as const, externalId: "orig-1" };
      },
    };
    const gw = new ActionGateway(store, flaky);
    const key = "r3b4-reuse";
    const grant = await gw.requestAction(baseReq({ idempotencyKey: key, payload: { consent: "grant" } }));
    expect(grant.status).toBe("needs_approval");
    const first = await gw.approveAndExecute(grant.approval!.id, "maria");
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");

    const revoke = await gw.requestAction(baseReq({ idempotencyKey: key, payload: { consent: "revoke" } }));
    expect(revoke.status).toBe("needs_approval");
    const second = await gw.approveAndExecute(revoke.approval!.id, "maria");
    expect(second.status).toBe("blocked");
    expect(second.reason).toMatch(/different content/);
    expect(calls.length).toBe(1);
    expect(store.getAttempt(key)?.status).toBe("unknown");
  });

  it("builds a reconciled receipt from the persisted attempt", async () => {
    const storage = openTestStorage() as never;
    ensureGatewayTables(storage);
    const store = new SqlApprovalStore(storage);
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(store, exec);
    const key = "r3b4-legacy";
    // A pre-hash attempt row: content cannot be verified, so the receipt
    // must come from the persisted row, not the new request.
    store.insertAttempt({
      key,
      status: "unknown",
      updatedAt: new Date().toISOString(),
      requestHash: "",
      actionType: "submit",
      recipient: "sandbox-agency",
      personId: "maria",
    });
    await exec.execute(baseReq({ idempotencyKey: key }));

    const settled = await gw.execute(baseReq({ idempotencyKey: key, type: "send", recipient: "someone-else" }));
    expect(settled.status).toBe("reconciled");
    expect(settled.receipt).toMatchObject({ actionType: "submit", recipient: "sandbox-agency" });
  });
});
