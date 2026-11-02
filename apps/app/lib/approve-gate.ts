// The Approve gate, decided in one place so the screen cannot drift
// from it. Approve enables only when the approval is pending, the
// current document loaded and matched its hash, the viewer reported a
// successful render, and the request parsed to a known shape.

import type { ApprovalStatus } from "./api/types";

export type GateReason =
  | "ready"
  | "not-pending"
  | "stale"
  | "decided"
  | "busy"
  | "loading-doc"
  | "hash-mismatch"
  | "not-shown"
  | "unknown-action";

export interface GateInput {
  status: ApprovalStatus;
  stale: boolean;
  decided: boolean;
  busy: boolean;
  docState: "loading" | "ready" | "failed";
  // Approvals without a document skip the document checks.
  hasDocument: boolean;
  hashMatches: boolean;
  rendered: boolean;
  actionKnown: boolean;
}

export function approvalGate(input: GateInput): { canApprove: boolean; reason: GateReason } {
  if (input.status !== "pending") return { canApprove: false, reason: "not-pending" };
  if (input.stale) return { canApprove: false, reason: "stale" };
  if (input.decided) return { canApprove: false, reason: "decided" };
  if (input.busy) return { canApprove: false, reason: "busy" };
  if (input.hasDocument && input.docState !== "ready") {
    return { canApprove: false, reason: "loading-doc" };
  }
  if (input.hasDocument && !input.hashMatches) return { canApprove: false, reason: "hash-mismatch" };
  if (input.hasDocument && !input.rendered) return { canApprove: false, reason: "not-shown" };
  if (!input.actionKnown) return { canApprove: false, reason: "unknown-action" };
  return { canApprove: true, reason: "ready" };
}
