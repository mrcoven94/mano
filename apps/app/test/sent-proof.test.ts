import { describe, expect, it } from "vitest";
import { provenNotSent } from "../lib/sent-proof";
import type { Approval } from "../lib/api/types";

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "appr-a",
    actionType: "submit",
    recipient: "r",
    recipientName: "R",
    purpose: "p",
    documentHash: "d",
    documentId: "doc-1",
    documentName: null,
    requestJson: "{}",
    requestHash: "h",
    idempotencyKey: "k",
    status: "pending",
    problems: [],
    createdAt: "2026-10-28T00:00:00.000Z",
    remindAt: "2026-11-03T09:00:00.000Z",
    expiresAt: "2026-11-10T09:00:00.000Z",
    escalated: false,
    attempted: false,
    ...overrides,
  };
}

describe("provenNotSent", () => {
  it("proves nothing went only when every approval under the key stopped short of a send", () => {
    for (const status of ["pending", "rejected", "expired", "stale", "blocked"] as const) {
      expect(provenNotSent([approval({ status })])).toBe(true);
    }
  });

  it("never proves it for an approval sent from another device after its document failed to load", () => {
    expect(provenNotSent([approval({ status: "approved" })])).toBe(false);
    expect(provenNotSent([approval({ status: "revoked" })])).toBe(false);
  });

  it("never proves it when a reproposal under the same key was sent", () => {
    const expired = approval({ status: "expired" });
    const resent = approval({ id: "appr-b", status: "approved", attempted: true });
    expect(provenNotSent([expired, resent])).toBe(false);
    expect(provenNotSent([expired, approval({ id: "appr-b", status: "rejected", attempted: true })])).toBe(false);
  });

  it("fails closed on a status it does not know", () => {
    expect(provenNotSent([approval({ status: "archived" as Approval["status"] })])).toBe(false);
  });
});
