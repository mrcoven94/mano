import { describe, expect, it } from "vitest";
import { approvalGate, type GateInput } from "../lib/approve-gate";

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    status: "pending",
    stale: false,
    decided: false,
    busy: false,
    docState: "ready",
    hasDocument: true,
    hashMatches: true,
    rendered: true,
    actionKnown: true,
    ...overrides,
  };
}

describe("approvalGate", () => {
  it("opens only when everything checks out", () => {
    expect(approvalGate(input())).toEqual({ canApprove: true, reason: "ready" });
  });

  it("stays shut while the document loads, mismatches or never renders", () => {
    expect(approvalGate(input({ docState: "loading" }))).toEqual({ canApprove: false, reason: "loading-doc" });
    expect(approvalGate(input({ docState: "failed" }))).toEqual({ canApprove: false, reason: "loading-doc" });
    expect(approvalGate(input({ hashMatches: false }))).toEqual({ canApprove: false, reason: "hash-mismatch" });
    expect(approvalGate(input({ rendered: false }))).toEqual({ canApprove: false, reason: "not-shown" });
  });

  it("stays shut for unknown actions, stale rows and settled states", () => {
    expect(approvalGate(input({ actionKnown: false }))).toEqual({ canApprove: false, reason: "unknown-action" });
    expect(approvalGate(input({ stale: true }))).toEqual({ canApprove: false, reason: "stale" });
    expect(approvalGate(input({ decided: true }))).toEqual({ canApprove: false, reason: "decided" });
    expect(approvalGate(input({ status: "approved" }))).toEqual({ canApprove: false, reason: "not-pending" });
    expect(approvalGate(input({ busy: true }))).toEqual({ canApprove: false, reason: "busy" });
  });

  it("skips document checks for approvals without one", () => {
    expect(approvalGate(input({ hasDocument: false, hashMatches: false, rendered: false, docState: "failed" }))).toEqual({
      canApprove: true,
      reason: "ready",
    });
  });
});
