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
  // Verified document bytes, attached by the gateway after it reads them
  // from server storage. Never accepted from caller input: validation
  // drops it, and hashes exclude it.
  document?: { bytesB64: string; hash: string };
}

export interface Approval {
  id: string;
  actionType: ActionType;
  recipient: string;
  purpose: string;
  documentHash: string | null;
  documentId: string | null;
  idempotencyKey: string;
  status: "pending" | "approved" | "rejected" | "revoked" | "expired" | "stale" | "blocked";
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
  // Hash of the canonical request this receipt answers. Reuse of the key
  // with different content is rejected instead of returning this receipt.
  requestHash: string;
  createdAt: string;
}

// One execution claim for an idempotency key. in_flight while the executor
// runs, unknown when a timeout left the outcome uncertain, failed when the
// action definitely did not happen (clean retry allowed), done once a
// receipt is recorded.
export interface Attempt {
  key: string;
  status: "in_flight" | "unknown" | "failed" | "done";
  updatedAt: string;
  // Hash of the canonical request that claimed the key. A retry with
  // different content under the same key is rejected.
  requestHash: string;
  // Routing context, so recovery can reconcile a stranded attempt without
  // asking the person to approve again.
  actionType: ActionType;
  recipient: string;
  personId: string;
}

export interface GatewayResult {
  status: "completed" | "needs_approval" | "rejected" | "blocked" | "stale" | "reconciled" | "in_progress";
  approval?: Approval;
  receipt?: Receipt;
  reason?: string;
}

export interface Executor {
  // True when this executor simulates outside systems instead of calling
  // them. Receipts carry the flag so drills never read as real filings.
  readonly simulated: boolean;
  // Runs the action. An execution may override the simulated label for
  // its own receipt when the action is real even though the executor is
  // a stand-in for other actions (consent delivery to a live org agent).
  execute(req: ActionRequest): Promise<{ externalId: string; simulated?: boolean }>;
  // Reconcile lookup with three outcomes: found, confirmed absent, or
  // unavailable (thrown). Unavailable never counts as absent: the gateway
  // keeps the attempt unknown and blocks. personId scopes the lookup to
  // the person's own downstream keys.
  check(idempotencyKey: string, personId: string): Promise<CheckOutcome>;
}

// The recorded outcome for a key: found carries the outside ID, absent
// means the executor confirms it never ran this key.
export type CheckOutcome = { found: true; externalId: string } | { found: false };

export class TimeoutError extends Error {
  constructor(msg = "executor timed out") {
    super(msg);
    this.name = "TimeoutError";
  }
}

// The action definitely did not happen: a 4xx from the portal, an org
// rejection, a request the executor refused before acting. The gateway
// records a failed attempt, which allows a clean retry with no reconcile.
export class DefiniteFailureError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DefiniteFailureError";
  }
}
