/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { TimeoutError } from "../src/gateway/types.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// Round 3, blocker 6 against the real SQLite store: an uncertain
// approved action reconciles on retry without a new approval, recovery
// sweeps unknown attempts, and reconciling comes before any expiry
// decision.

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
// state a retry must reconcile. The first lookup misses; later ones hit.
function openGateway() {
  const storage = openTestStorage() as never;
  ensureGatewayTables(storage);
  const store = new SqlApprovalStore(storage);
  const calls: ActionRequest[] = [];
  const recorded = new Map<string, { externalId: string }>();
  let checks = 0;
  const exec: Executor = {
    simulated: true,
    async execute(req) {
      calls.push(req);
      recorded.set(req.idempotencyKey, { externalId: "ext-1" });
      throw new TimeoutError();
    },
    async check(key) {
      checks += 1;
      if (checks === 1) return { found: false as const };
      const hit = recorded.get(key);
      return hit ? { found: true as const, externalId: hit.externalId } : { found: false as const };
    },
  };
  const gw = new ActionGateway(store, exec);
  return { store, exec, gw, calls };
}

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r3b6n-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r3 blocker 6: uncertain approved actions recover", () => {
  it("reconciles a consumed approval on retry without a new approval", async () => {
    const { store, gw, calls } = openGateway();
    const key = "r3b6-retry";
    const pending = await gw.requestAction(baseReq({ idempotencyKey: key }));
    const first = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");

    const retry = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(retry.status).toBe("reconciled");
    expect(calls.length).toBe(1);
    expect(store.getAttempt(key)?.status).toBe("done");
  });

  it("reconciles before deciding expiry during recovery", async () => {
    const { store, gw, calls } = openGateway();
    const key = "r3b6-expired";
    const pending = await gw.requestAction(baseReq({ idempotencyKey: key }));
    await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(store.getAttempt(key)?.status).toBe("unknown");

    // A day later the window passed, but the action happened: the person
    // still gets the receipt.
    const late = new Date(Date.now() + 25 * 3600_000);
    const recovered = await gw.recoverAttempt(key, late, new Date(Date.now() + 3600_000).toISOString());
    expect(recovered?.status).toBe("reconciled");
    expect(calls.length).toBe(1);
  });

  it("recovery sweeps old unknown attempts, not just stranded in-flight ones", async () => {
    const { store, gw } = openGateway();
    const key = "r3b6-sweep";
    store.insertAttempt({
      key,
      status: "unknown",
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      requestHash: "",
      actionType: "submit",
      recipient: "sandbox-agency",
      personId: "maria",
    });
    const found = store.listRecoverableAttempts(new Date(Date.now() - 300_000).toISOString());
    expect(found.map((a) => a.key)).toContain(key);
    const recovered = await gw.recoverAttempt(key, new Date(), new Date(Date.now() - 300_000).toISOString());
    // Allow path with no executor record: marked failed so a fresh
    // request retries cleanly.
    expect(recovered?.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("failed");
  });
});
