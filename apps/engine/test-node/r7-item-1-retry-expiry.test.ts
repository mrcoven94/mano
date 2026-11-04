/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { DefiniteFailureError } from "../src/gateway/types.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// Round 7, item 1 against the real SQLite store: a consumed-approval
// retry never starts executing after the approval expires, even when the
// audit digest of the idempotency key is slow. The digest of that key is
// delayed 150 ms; the window closes 75 ms into the retry.

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

function slowDigestFor(text: string, delayMs: number) {
  const subtle = crypto.subtle;
  const original = subtle.digest.bind(subtle);
  vi.spyOn(subtle, "digest").mockImplementation(async (algorithm, data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    if (new TextDecoder().decode(bytes) === text) await new Promise((r) => setTimeout(r, delayMs));
    return original(algorithm, data);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("r7 item 1: consumed-approval retry respects expiry", () => {
  it("does not execute after expiry when the key digest is slow", async () => {
    const storage = openTestStorage();
    ensureGatewayTables(storage as never);
    const store = new SqlApprovalStore(storage as never);
    const startedAt: number[] = [];
    const exec: Executor = {
      simulated: true,
      async execute() {
        startedAt.push(Date.now());
        throw new DefiniteFailureError("Sandbox portal rejected the action: 400");
      },
      async check() {
        return { found: false as const };
      },
    };
    const gw = new ActionGateway(store, exec);
    const key = "r7i1-slow-digest";
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
    expect(store.getAttempt(key)?.status).toBe("failed");
    expect(startedAt.length).toBe(1);

    const expiresAtMs = Date.now() + 75;
    const approval = store.getApproval(pending.approval!.id)!;
    store.putApproval({ ...approval, expiresAt: new Date(expiresAtMs).toISOString() });
    slowDigestFor(key, 150);

    const retried = await gw.approveAndExecute(pending.approval!.id, "maria");
    const lateStarts = startedAt.slice(1).filter((t) => t > expiresAtMs);
    expect(lateStarts.map((t) => `${t - expiresAtMs} ms after expiry`)).toEqual([]);
    expect(retried.status).toBe("blocked");
    expect(retried.reason).toMatch(/expired/i);
  });
});
