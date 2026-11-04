import type { SourceCitation } from "@mano/protocol";

export type ActionType = "send" | "submit" | "call" | "fax" | "mail" | "share";
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
  // The person who answered YES to this exact request, attached by the
  // gateway from the approval they answered. Never accepted from caller
  // input, excluded from hashes, and absent on the allow path, where no
  // person answered.
  answeredBy?: string;
}

export interface Approval {
  id: string;
  actionType: ActionType;
  recipient: string;
  purpose: string;
  documentHash: string | null;
  documentId: string | null;
  idempotencyKey: string;
  // retired: was approved, then the person corrected the form after its
  // filing failed or went unanswered; it is reconciled but never run again.
  status: "pending" | "approved" | "retired" | "rejected" | "revoked" | "expired" | "stale" | "blocked";
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
  // Bumped by every write to the attempt, so a step that read it before an
  // await can tell whether anything claimed or ran it since.
  version?: number;
  // The real provider this attempt began against, recorded when it starts,
  // or null on a stand-in. It answers for the attempt from then on: with
  // that provider gone, the attempt stays unknown, in any mode.
  provider?: string | null;
  // When lookups for this attempt began failing to give an answer, and when
  // the recovery sweep looks again. Failing since a time with no next
  // lookup means the sweep has stopped; a person's own YES still looks.
  lookupFailingSince?: string | null;
  nextLookupAt?: string | null;
}

export interface GatewayResult {
  status: "completed" | "needs_approval" | "rejected" | "blocked" | "stale" | "reconciled" | "in_progress";
  approval?: Approval;
  receipt?: Receipt;
  reason?: string;
  // Set on a refused approve: a newer proposal replaced this one.
  superseded?: true;
  // Set on a completed answer that only reports a receipt another request
  // already recorded. Nothing ran in this call, so a caller applies no
  // effects for it (a consent grant is never re-recorded).
  replayed?: true;
  // Set on a refused approve when the safety check could not answer. The
  // approval still waits, nothing ran, and the same approve may be sent
  // again later.
  retryable?: true;
  // Set when a send could not be confirmed and will not be retried. The
  // person is told, and only a fresh approval can send it again.
  unconfirmed?: true;
}

// Where a drafted approval sits among the person's proposals: when the
// turn that drafted it was received, then that turn's ID.
export interface ProposalOrder {
  receivedAt: string;
  turnId: string;
}

export interface LatestProposal extends ProposalOrder {
  approvalId: string;
}

export interface Executor {
  // True when this executor simulates outside systems instead of calling
  // them. Receipts carry the flag so drills never read as real filings.
  readonly simulated: boolean;
  // The real outside provider this executor sends through, if it has one.
  readonly provider?: string;
  // Which real provider a new attempt for this request would begin against.
  providerOf?(req: ActionRequest): string | null;
  // Runs the action. An execution may override the simulated label for
  // its own receipt when the action is real even though the executor is
  // a stand-in for other actions (consent delivery to a live org agent).
  execute(req: ActionRequest): Promise<{ externalId: string; simulated?: boolean }>;
  // Reconcile lookup with three outcomes: found, confirmed absent, or
  // unavailable (thrown). Unavailable never counts as absent: the gateway
  // keeps the attempt unknown and blocks. personId scopes the lookup to
  // the person's own downstream keys.
  check(idempotencyKey: string, personId: string): Promise<CheckOutcome>;
  // Why this executor could not carry out the request, or null when it
  // can. req carries the verified document exactly as execute would get
  // it. The gateway asks before it drafts an approval or executes, so a
  // person is never asked to approve an action that would then be
  // refused. An executor without it takes every request.
  refuse?(req: ActionRequest): string | null | Promise<string | null>;
  // Whether this executor could file a stored document of this media type
  // and size, without reading its bytes. The person's document list
  // answers it for each document so Mano attaches one the filing takes.
  // An executor without it takes any document.
  documentFiling?(doc: StoredDocumentFacts): DocumentFiling;
}

// What Engine recorded about a document when it stored it: the media
// type read from its bytes, and its size (null when stored before sizes
// were recorded).
export interface StoredDocumentFacts {
  mediaType: string | null;
  sizeBytes: number | null;
}
export type DocumentFiling = "fileable" | "too_large" | "wrong_type" | "size_unknown";

// The recorded outcome for a key: found carries the outside ID, absent
// means the executor confirms it never ran this key. simulated labels a
// receipt the way execute would, when that differs from the executor's own.
export type CheckOutcome = { found: true; externalId: string; simulated?: boolean } | { found: false };

export class TimeoutError extends Error {
  constructor(msg = "executor timed out") {
    super(msg);
    this.name = "TimeoutError";
  }
}

// The lookup answered and does not list a send that went to a provider
// with no dedupe. It may still land, so it is neither found nor absent: the
// attempt stays unknown and only a fresh approval can send again.
export class UnconfirmedSendError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UnconfirmedSendError";
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
