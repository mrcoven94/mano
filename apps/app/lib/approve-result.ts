// Outcome of an approval call, decided from the gateway result. Only a
// completed or reconciled result with a receipt reads as sent; every
// other status gets its own honest screen.

import type { ApproveResult } from "./api/types";

export type ApproveOutcome = "sent" | "blocked" | "stale" | "needs-approval" | "sending";

export function approveOutcome(result: ApproveResult): ApproveOutcome {
  if ((result.status === "completed" || result.status === "reconciled") && result.receiptId) {
    return "sent";
  }
  if (result.status === "blocked") return "blocked";
  if (result.status === "stale") return "stale";
  if (result.status === "needs_approval") return "needs-approval";
  return "sending";
}
