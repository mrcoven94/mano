import type { SourceCitation } from "@mano/protocol";

export type ActionType = "send" | "submit" | "call" | "fax" | "share";
export type PolicyDecision = "allow" | "ask" | "block";
export type ActorKind = "foreground" | "background";

export interface ActionRequest {
  type: ActionType;
  recipient: string;
  purpose: string;
  // Document bytes always come from server storage, never from the caller,
  // so the request carries only the document ID.
  documentId?: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  actor: ActorKind;
  caseId?: string;
  deadlineAt?: string;
  personId: string;
  // Evidence the action is based on, and where the request originated. The
  // gateway fills defaults (no sources, person origin) when they are absent.
  sources?: SourceCitation[];
  origin?: "person" | "content";
}

export interface Approval {
  id: string;
  actionType: ActionType;
  recipient: string;
  purpose: string;
  documentHash: string | null;
  documentId: string | null;
  idempotencyKey: string;
  status: "pending" | "approved" | "expired" | "stale" | "blocked";
  approvedByHumanId: string | null;
  // The person this approval belongs to, the frozen request it authorizes
  // (canonical JSON, executed verbatim), and the hash binding type,
  // recipient, purpose, payload, person, key and document bytes.
  personId: string;
  requestJson: string;
  requestHash: string;
  problems: string[];
  createdAt: string;
  remindAt: string;
  expiresAt: string;
  escalated: boolean;
}

export interface Receipt {
  id: string;
  idempotencyKey: string;
  actionType: ActionType;
  recipient: string;
  status: "completed" | "reconciled";
  externalId: string;
  // True when a stand-in executor produced this receipt instead of a real
  // outside system. Simulated receipts must never read as real filings.
  simulated: boolean;
  createdAt: string;
}

// One execution claim for an idempotency key. in_flight while the executor
// runs, unknown when a timeout left the outcome uncertain, done once a
// receipt (or a definitive failure) is recorded.
export interface Attempt {
  key: string;
  status: "in_flight" | "unknown" | "done";
  updatedAt: string;
}

export interface GatewayResult {
  status: "completed" | "needs_approval" | "blocked" | "stale" | "reconciled" | "in_progress";
  approval?: Approval;
  receipt?: Receipt;
  reason?: string;
}

export interface Executor {
  // True when this executor simulates outside systems instead of calling
  // them. Receipts carry the flag so drills never read as real filings.
  readonly simulated: boolean;
  execute(req: ActionRequest): Promise<{ externalId: string }>;
  // Returns the recorded outcome for a key, or null when the executor has
  // no record of it. After an unknown outcome the gateway calls check
  // again before any new execution, so check must be authoritative and
  // execute must stay safe to retry under the same key.
  check(idempotencyKey: string): Promise<{ externalId: string } | null>;
}

export class TimeoutError extends Error {
  constructor(msg = "executor timed out") {
    super(msg);
    this.name = "TimeoutError";
  }
}
