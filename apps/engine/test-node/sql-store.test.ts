/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import type { Approval } from "../src/gateway/types.js";

// Minimal adapter from node:sqlite to the SqlStorage surface the store uses.
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

function openStorePair() {
  const storage = openTestStorage() as never;
  ensureGatewayTables(storage as never);
  const first = new SqlApprovalStore(storage as never);
  const second = new SqlApprovalStore(storage as never);
  return { first, second };
}

function pendingApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: `appr-${crypto.randomUUID()}`,
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
    requestHash: "hash",
    problems: [],
    createdAt: new Date().toISOString(),
    remindAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    escalated: false,
    ...over,
  };
}

describe("blocker 6: approvals, attempts and receipts survive eviction", () => {
  it("finds approvals and receipts from a fresh store over the same storage", () => {
    const { first, second } = openStorePair();
    const approval = pendingApproval();
    first.putApproval(approval);
    first.putReceipt({
      id: "r-1",
      idempotencyKey: approval.idempotencyKey,
      actionType: "submit",
      recipient: "sandbox-agency",
      status: "completed",
      externalId: "ext-1",
      simulated: true,
      createdAt: new Date().toISOString(),
    });

    // `second` is a fresh agent instance after eviction: same SQLite, new objects.
    expect(second.getApproval(approval.id)?.status).toBe("pending");
    expect(second.getReceiptByKey(approval.idempotencyKey)?.externalId).toBe("ext-1");
  });

  it("consumes an approval and its attempt atomically", () => {
    const { first, second } = openStorePair();
    const approval = pendingApproval();
    first.putApproval(approval);
    const attempt = { key: approval.idempotencyKey, status: "in_flight" as const, updatedAt: new Date().toISOString() };

    const consumed = first.consumeApprovalAndClaim(approval.id, "maria", attempt);
    expect(consumed?.status).toBe("approved");
    expect(second.getAttempt(approval.idempotencyKey)?.status).toBe("in_flight");

    // A second consumer gets nothing: the approval is no longer pending.
    expect(second.consumeApprovalAndClaim(approval.id, "maria", attempt)).toBeNull();
    expect(first.getApproval(approval.id)?.status).toBe("approved");
  });

  it("adopts an unknown attempt so a retry can reconcile first", () => {
    const { first } = openStorePair();
    const approval = pendingApproval();
    first.putApproval(approval);
    const unknown = { key: approval.idempotencyKey, status: "unknown" as const, updatedAt: new Date().toISOString() };
    expect(first.insertAttempt(unknown)).toBe(true);

    expect(first.adoptUnknownAttempt(approval.idempotencyKey, new Date())).toBe(true);
    expect(first.getAttempt(approval.idempotencyKey)?.status).toBe("in_flight");
    expect(first.adoptUnknownAttempt(approval.idempotencyKey, new Date())).toBe(false);
  });

  it("refuses to consume when the idempotency key is already claimed", () => {
    const { first } = openStorePair();
    const approval = pendingApproval();
    first.putApproval(approval);
    const attempt = { key: approval.idempotencyKey, status: "in_flight" as const, updatedAt: new Date().toISOString() };
    expect(first.insertAttempt(attempt)).toBe(true);

    expect(first.consumeApprovalAndClaim(approval.id, "maria", attempt)).toBeNull();
    expect(first.getApproval(approval.id)?.status).toBe("pending");
  });
});
