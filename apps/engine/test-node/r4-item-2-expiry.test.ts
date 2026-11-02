/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { TimeoutError } from "../src/gateway/types.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// Round 4, item 2 against the real SQLite store: a consumed approval's
// attempt always reconciles, whatever the approval's expiry; expiry only
// stops new execution. Elapsed time is simulated by backdating the row in
// real SQL; every other step runs production code.

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

// Records the outcome, then reports the timeout: exactly the uncertain
// state a retry must reconcile.
function openGateway(checks: { found: boolean }) {
  const storage = openTestStorage();
  ensureGatewayTables(storage as never);
  const store = new SqlApprovalStore(storage as never);
  const calls: ActionRequest[] = [];
  const recorded = new Map<string, { externalId: string }>();
  let lookups = 0;
  const exec: Executor = {
    simulated: true,
    async execute(req) {
      calls.push(req);
      recorded.set(req.idempotencyKey, { externalId: "ext-1" });
      throw new TimeoutError();
    },
    async check(key) {
      lookups += 1;
      // The first lookup misses, leaving the attempt unknown; later
      // ones find it, unless this run models an empty outside system.
      if (!checks.found || lookups === 1) return { found: false as const };
      const hit = recorded.get(key);
      return hit ? { found: true as const, externalId: hit.externalId } : { found: false as const };
    },
  };
  const gw = new ActionGateway(store, exec);
  return { storage, store, gw, calls };
}

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r4i2n-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r4 item 2: consumed approvals reconcile after expiry", () => {
  it("reconciles an unknown attempt even though the approval expired", async () => {
    const { storage, store, gw } = openGateway({ found: true });
    const key = "r4i2-reconcile";
    const pending = await gw.requestAction(baseReq({ idempotencyKey: key }));
    const first = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(store.getApproval(pending.approval!.id)?.status).toBe("approved");

    // Time passes past the approval window.
    storage.exec("UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), pending.approval!.id);

    const retry = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(retry.status).toBe("reconciled");
    expect(retry.receipt?.externalId).toBe("ext-1");
  });

  it("still refuses new execution once the approval expired", async () => {
    const { storage, store, gw, calls } = openGateway({ found: false });
    const key = "r4i2-noexec";
    const pending = await gw.requestAction(baseReq({ idempotencyKey: key }));
    await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(calls.length).toBe(1);

    storage.exec("UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), pending.approval!.id);

    // Nothing to reconcile (the lookup is empty), so expiry stops the
    // retry from executing again.
    const retry = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(retry.status).toBe("blocked");
    expect(retry.reason).toMatch(/expired/i);
    expect(calls.length).toBe(1);
  });

  it("still refuses an expired approval that was never consumed", async () => {
    const { storage, gw, calls } = openGateway({ found: true });
    const pending = await gw.requestAction(baseReq({ idempotencyKey: "r4i2-pending" }));
    storage.exec("UPDATE approvals SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), pending.approval!.id);

    const result = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/expired/i);
    expect(calls.length).toBe(0);
  });
});
