/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import type { Approval } from "../src/gateway/types.js";

// Re-review blocker 2 at the store level: lifecycle transitions are
// guarded updates, and consume re-checks owner, hash and expiry inside
// the consuming statement.

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

function openStore() {
  const storage = openTestStorage() as never;
  ensureGatewayTables(storage as never);
  return new SqlApprovalStore(storage as never);
}

function pendingApproval(over: Partial<Approval> = {}): Approval {
  const now = new Date();
  return {
    id: `r2-${crypto.randomUUID()}`,
    actionType: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    documentHash: null,
    documentId: null,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    status: "pending",
    approvedByHumanId: null,
    personId: "maria",
    requestJson: JSON.stringify({ type: "submit" }),
    requestHash: "hash-1",
    problems: [],
    createdAt: now.toISOString(),
    remindAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    escalated: false,
    ...over,
  };
}

function attemptFor(a: Approval) {
  return {
    key: a.idempotencyKey,
    status: "in_flight" as const,
    updatedAt: new Date().toISOString(),
    requestHash: "content-1",
    actionType: a.actionType,
    recipient: a.recipient,
    personId: a.personId,
  };
}

describe("r2 blocker 2: guarded store transitions", () => {
  it("consume re-checks owner, request hash and expiry", () => {
    const store = openStore();
    const good = pendingApproval();
    store.putApproval(good);
    const guard = { personId: "maria", requestHash: "hash-1" };
    expect(store.consumeApprovalAndClaim(good.id, "maria", attemptFor(good), guard)).not.toBeNull();

    const wrongOwner = pendingApproval();
    store.putApproval(wrongOwner);
    expect(
      store.consumeApprovalAndClaim(wrongOwner.id, "eve", attemptFor(wrongOwner), { ...guard, personId: "eve" }),
    ).toBeNull();

    const changed = pendingApproval();
    store.putApproval(changed);
    expect(
      store.consumeApprovalAndClaim(changed.id, "maria", attemptFor(changed), { ...guard, requestHash: "hash-2" }),
    ).toBeNull();

    const expired = pendingApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    store.putApproval(expired);
    expect(store.consumeApprovalAndClaim(expired.id, "maria", attemptFor(expired), guard)).toBeNull();
    expect(store.getApproval(expired.id)?.status).toBe("pending");
  });

  it("transitions only touch pending rows and only the intended fields", () => {
    const store = openStore();
    const approval = pendingApproval({ problems: ["old"] });
    store.putApproval(approval);
    store.setApprovalProblems(approval.id, ["new"]);
    const updated = store.getApproval(approval.id)!;
    expect(updated.problems).toEqual(["new"]);
    expect(updated.status).toBe("pending");

    expect(store.expireApproval(approval.id)).toBe(true);
    expect(store.getApproval(approval.id)?.status).toBe("expired");
    expect(store.expireApproval(approval.id)).toBe(false);
    expect(store.markApprovalStale(approval.id)).toBe(false);
    expect(store.escalateApproval(approval.id)).toBe(false);
  });
});
