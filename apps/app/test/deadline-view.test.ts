import { describe, expect, it } from "vitest";
import type { Deadline } from "../lib/api/types";
import { deadlineCard } from "../lib/deadline-view";

const deadline = (overrides: Partial<Deadline> = {}): Deadline => ({
  id: "d",
  title: "t",
  detail: null,
  dueAt: "2026-11-15T17:00:00.000Z",
  relatedApprovalId: null,
  done: false,
  ...overrides,
});

describe("deadlineCard", () => {
  it("says the person approved only when the approval on file says so", () => {
    expect(deadlineCard(deadline({ done: true, relatedApprovalId: "a" }), "approved")).toEqual({ state: "approved" });
  });

  it("says only done for anything else that finished", () => {
    expect(deadlineCard(deadline({ done: true }), undefined)).toEqual({ state: "done" });
    for (const status of ["rejected", "expired", "stale", "blocked", "revoked", "pending", undefined] as const) {
      expect(deadlineCard(deadline({ done: true, relatedApprovalId: "a" }), status)).toEqual({ state: "done" });
    }
  });

  it("says an approval waits only while it is pending or could not be read", () => {
    const open = deadline({ relatedApprovalId: "a" });
    expect(deadlineCard(open, "pending")).toMatchObject({ state: "open", approvalWaits: true });
    expect(deadlineCard(open, undefined)).toMatchObject({ state: "open", approvalWaits: true });
    for (const status of ["rejected", "approved", "expired", "stale", "blocked", "revoked"] as const) {
      expect(deadlineCard(open, status)).toMatchObject({ state: "open", approvalWaits: false });
    }
  });

  it("offers the photo only on an open deadline that asks for one", () => {
    expect(deadlineCard(deadline({ photoOf: "pay-stub" }), undefined)).toEqual({ state: "open", approvalWaits: false, photoOf: "pay-stub" });
    expect(deadlineCard(deadline(), undefined)).toEqual({ state: "open", approvalWaits: false, photoOf: null });
    expect(deadlineCard(deadline({ photoOf: "pay-stub", done: true }), undefined)).toEqual({ state: "done" });
  });
});
