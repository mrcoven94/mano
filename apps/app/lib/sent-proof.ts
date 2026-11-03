// Whether the screen may tell a person nothing was sent. Only when every
// approval under the action's idempotency key stopped short of a send:
// a status that never reached a send, and no attempt or receipt on file.
// An approval that expired while a reproposal under the same key went
// out does not qualify. Unknown statuses fail closed.

import type { Approval, ApprovalStatus } from "./api/types";

const NEVER_SENT: ReadonlySet<ApprovalStatus> = new Set(["pending", "rejected", "expired", "stale", "blocked"]);

// rows: every approval sharing one idempotency key.
export function provenNotSent(rows: readonly Approval[]): boolean {
  return rows.every((a) => NEVER_SENT.has(a.status) && !a.attempted);
}
