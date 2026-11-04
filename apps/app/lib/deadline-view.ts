// What a deadline card says about itself, from the deadline and, when known,
// its approval. "Done" only means the deadline closed, so it never claims
// anything was sent, and "You approved this" needs the approval on file to
// say so. A link says an approval needs the person only while one does.

import type { ApprovalStatus, Deadline } from "./api/types";

export type DeadlineCard =
  | { state: "approved" }
  | { state: "done" }
  | { state: "open"; approvalWaits: boolean; photoOf: Deadline["photoOf"] | null };

// status: the related approval's, or undefined when it could not be read.
export function deadlineCard(deadline: Deadline, status: ApprovalStatus | undefined): DeadlineCard {
  if (deadline.done) return deadline.relatedApprovalId && status === "approved" ? { state: "approved" } : { state: "done" };
  return {
    state: "open",
    approvalWaits: deadline.relatedApprovalId !== null && (status === undefined || status === "pending"),
    photoOf: deadline.photoOf ?? null,
  };
}
