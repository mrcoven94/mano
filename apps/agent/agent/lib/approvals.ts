// Approval records: every yes-or-no decision the person makes through
// the approval tool, with who decided and when. Durable per-session
// state; the audit trail for anything that left Mano.
import { defineState } from "eve/context";

export interface ApprovalRecord {
  id: string;
  action: string;
  detail: string;
  decision: "yes" | "no";
  decidedBy: string;
  decidedAt: string;
  answerText: string | null;
}

export const approvalsState = defineState<ApprovalRecord[]>("mano.approvals", () => []);

export const MAX_APPROVAL_RECORDS = 100;

export function appendApproval(records: ApprovalRecord[], record: ApprovalRecord): ApprovalRecord[] {
  return [...records, record].slice(-MAX_APPROVAL_RECORDS);
}
