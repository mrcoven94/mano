/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { MemoryApprovalStore } from "../src/gateway/gateway.js";
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

function attemptFor(a: { idempotencyKey: string; actionType: Approval["actionType"]; recipient: string; personId: string }) {
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

function pendingApproval(over: Partial<Approval> = {}): Approval {
  const now = new Date();
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
    createdAt: now.toISOString(),
    remindAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
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
      requestHash: "content-1",
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
    const attempt = attemptFor(approval);
    const guard = { personId: "maria", requestHash: "hash" };

    const consumed = first.consumeApprovalAndClaim(approval.id, "maria", attempt, guard);
    expect(consumed?.status).toBe("approved");
    expect(second.getAttempt(approval.idempotencyKey)?.status).toBe("in_flight");

    // A second consumer gets nothing: the approval is no longer pending.
    expect(second.consumeApprovalAndClaim(approval.id, "maria", attempt, guard)).toBeNull();
    expect(first.getApproval(approval.id)?.status).toBe("approved");
  });

  it("adopts an unknown attempt so a retry can reconcile first", () => {
    const { first } = openStorePair();
    const approval = pendingApproval();
    first.putApproval(approval);
    const unknown = { ...attemptFor(approval), status: "unknown" as const };
    expect(first.insertAttempt(unknown)).toBe(true);

    expect(first.adoptUnknownAttempt(approval.idempotencyKey, new Date())).toBe(true);
    expect(first.getAttempt(approval.idempotencyKey)?.status).toBe("in_flight");
    expect(first.adoptUnknownAttempt(approval.idempotencyKey, new Date())).toBe(false);
  });

  it("refuses to consume when the idempotency key is already claimed", () => {
    const { first } = openStorePair();
    const approval = pendingApproval();
    first.putApproval(approval);
    const attempt = attemptFor(approval);
    expect(first.insertAttempt(attempt)).toBe(true);

    expect(
      first.consumeApprovalAndClaim(approval.id, "maria", attempt, {
        personId: "maria",
        requestHash: "hash",
      }),
    ).toBeNull();
    expect(first.getApproval(approval.id)?.status).toBe("pending");
  });
});

describe("the latest proposal", () => {
  // Sol's review 7: closing an older draft can fail. Whether or not it
  // closed, an older draft can never be approved once a newer turn drafted.
  for (const [name, make] of [
    ["SQL store", () => openStorePair().first],
    ["memory store", () => new MemoryApprovalStore()],
  ] as const) {
    it(`${name}: moves only forward, and only the latest drafted approval can be consumed`, () => {
      const store = make();
      const a = pendingApproval({ requestHash: "content-1" });
      const b = pendingApproval({ requestHash: "content-1" });
      const plain = pendingApproval({ requestHash: "content-1" });
      const atA = { receivedAt: "2026-11-01T15:00:00.000Z", turnId: "turn-a" };
      const atB = { receivedAt: "2026-11-01T15:00:05.000Z", turnId: "turn-b" };
      store.createApprovalForKey(b, 0, atB);
      // A finishes after B: it is created, but never becomes the latest.
      store.createApprovalForKey(a, 0, atA);
      store.createApprovalForKey(plain, 0);
      expect(store.latestProposal()).toEqual({ approvalId: b.id, ...atB });
      expect(store.proposalCurrent(a.id)).toBe(false);
      expect(store.proposalCurrent(b.id)).toBe(true);
      expect(store.proposalCurrent(plain.id)).toBe(true);
      expect(store.consumeApprovalAndClaim(a.id, "maria", attemptFor(a), { personId: "maria", requestHash: "content-1" })).toBeNull();
      expect(store.getApproval(a.id)?.status).toBe("pending");
      expect(store.consumeApprovalAndClaim(b.id, "maria", attemptFor(b), { personId: "maria", requestHash: "content-1" })?.status).toBe(
        "approved",
      );
      expect(store.consumeApprovalAndClaim(plain.id, "maria", attemptFor(plain), { personId: "maria", requestHash: "content-1" })?.status).toBe(
        "approved",
      );
    });
  }
});
