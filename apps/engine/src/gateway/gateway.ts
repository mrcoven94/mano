import { canonicalJson } from "@mano/protocol";
import { sha256Hex, bytesToBase64 } from "../hash.js";
import { checkLinkSafety, extractHttpUrls, type LinkBlockReason } from "../link-safety.js";
import { approvalWindow, evaluatePolicy } from "./policy.js";
import type {
  ActionRequest,
  Approval,
  Attempt,
  Executor,
  GatewayResult,
  LatestProposal,
  PolicyDecision,
  ProposalOrder,
  Receipt,
} from "./types.js";
import { DefiniteFailureError, TimeoutError } from "./types.js";
import { auditDigest, type AuditDigest, type AuditEntry } from "./audit.js";
import { ValidationError, parseActionRequest } from "./validate.js";
import { LocalRulesChecker, checkerWithTimeout, type Checker, type CheckResult } from "./checker.js";

// Guard re-checked inside the consuming statement: the approval must still
// be pending, owned by this person and bound to this request hash. The
// expiry check reads the clock inside the claim itself, never from a
// timestamp the caller captured before its async work.
export interface ConsumeGuard {
  personId: string;
  requestHash: string;
}

export interface ApprovalStore {
  getApproval(id: string): Approval | null;
  // The approval behind an idempotency key, preferring the consumed one.
  // More than one approval can share a key; recovery wants the one that
  // claimed the attempt.
  getApprovalByKey(key: string): Approval | null;
  putApproval(a: Approval): void;
  // The person's conversation generation. A conversation delete advances
  // it; anything prepared under an older one is stale and never written.
  generation(): number;
  // One live approval per action key. Inserts a, recorded under
  // generation, only when no pending, approved, rejected or revoked
  // approval holds its key and generation is still current, in one step.
  // Returns whichever approval holds the key afterwards (a itself when
  // inserted), or null when the generation moved on.
  // With an order, the new approval is a drafted proposal: in the same
  // synchronous step it becomes the person's latest proposal, unless a
  // proposal of a newer turn already is. The latest proposal never moves
  // backwards within a generation.
  createApprovalForKey(a: Approval, generation: number, order?: ProposalOrder): Approval | null;
  // The newest drafted proposal of the current generation, or null.
  latestProposal(): LatestProposal | null;
  // Rejects, in one step decided at execution time, every pending drafted
  // proposal of this generation that is not the latest. Returns how many.
  // Nothing when the generation is no longer current.
  rejectSupersededProposals(generation: number): number;
  // False only for a drafted proposal that is no longer the latest one: it
  // can never be approved, whether or not closing it worked.
  proposalCurrent(id: string): boolean;
  // True while an approval's recorded generation is still current.
  approvalCurrent(id: string): boolean;
  // True while an approval is approved and its generation is current:
  // the only state in which it may start or restart execution.
  approvalAuthorized(id: string): boolean;
  // A NO is terminal for the key: every pending approval under it, the
  // person's own, becomes rejected in one step.
  rejectApprovalsForKey(key: string, personId: string): void;
  keyDeclined(key: string): boolean;
  // Atomically moves a pending approval to approved and records the
  // execution attempt. Returns null when the approval is not pending, the
  // owner, hash or expiry no longer match, or the key is already claimed
  // by different content. Implementations must perform the writes with no
  // await between them.
  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt, guard: ConsumeGuard): Approval | null;
  // Guarded lifecycle transitions: each updates only its own fields and
  // only when the row is still pending, so a stale snapshot can never
  // revive an expired, consumed or blocked approval.
  expireApproval(id: string): boolean;
  setApprovalBlocked(id: string): boolean;
  markApprovalStale(id: string): boolean;
  setApprovalProblems(id: string, problems: string[]): void;
  escalateApproval(id: string): boolean;
  getReceiptByKey(key: string): Receipt | null;
  putReceipt(r: Receipt): void;
  getAttempt(key: string): Attempt | null;
  // With a generation, inserts only while it is still current.
  insertAttempt(a: Attempt, generation?: number): boolean;
  // Compare-and-set: moves an unknown attempt back to in_flight so a retry
  // can adopt the key. False unless the attempt exists and is unknown.
  adoptUnknownAttempt(key: string, now: Date): boolean;
  // Compare-and-set for clean retries: moves a failed attempt back to
  // in_flight. False unless the attempt exists and is failed.
  adoptFailedAttempt(key: string, now: Date): boolean;
  // Compare-and-set for recovery: moves an unknown or orphaned in_flight
  // attempt back to in_flight only while its approval is still consumed,
  // unexpired and of the current generation (a conversation delete
  // revokes it), checked in the same statement. False otherwise, so a
  // window that lapses during recovery's awaited checks cannot execute.
  adoptForRecoveryIfApprovalLive(key: string, now: Date): boolean;
  // Claims an unresolved attempt for recovery: refreshes its timestamp
  // so a second recovery cannot claim it too.
  claimRecoverableAttempt(key: string, olderThanIso: string, now: Date): boolean;
  // Attempts recovery may own: in_flight or unknown and older than the
  // cutoff, so no live request can still be working them.
  listRecoverableAttempts(olderThanIso: string): Attempt[];
  // True when any attempt is in_flight or unknown. The agent schedules
  // a durable recovery run while this holds.
  hasUnresolvedAttempts(): boolean;
  updateAttempt(key: string, status: Attempt["status"]): void;
  audit<const T extends { event: string }>(entry: T & AuditEntry<T>): void;
}

// True when proposal a was drafted by an older turn than b.
export function olderProposal(a: ProposalOrder, b: ProposalOrder): boolean {
  return a.receivedAt < b.receivedAt || (a.receivedAt === b.receivedAt && a.turnId < b.turnId);
}

export const SUPERSEDED_REASON = "A newer request replaced this one, so it can no longer be approved.";

// Statuses that hold an action key, in the order a lookup prefers them:
// a NO first, then a revocation, then the consumed approval, then the
// live one.
export const KEY_HOLDING: readonly Approval["status"][] = ["rejected", "revoked", "approved", "pending"];

function transition(store: Map<string, Approval>, id: string, to: Approval["status"]): boolean {
  const current = store.get(id);
  if (!current || current.status !== "pending") return false;
  store.set(id, { ...current, status: to });
  return true;
}

export class MemoryApprovalStore implements ApprovalStore {
  approvals = new Map<string, Approval>();
  receipts = new Map<string, Receipt>();
  attempts = new Map<string, Attempt>();
  auditLog: Record<string, unknown>[] = [];
  getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }
  getApprovalByKey(key: string): Approval | null {
    const matches = [...this.approvals.values()].filter((a) => a.idempotencyKey === key);
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const rank = (s: string) => (s === "approved" ? 0 : 1);
      return rank(a.status) - rank(b.status) || (a.createdAt < b.createdAt ? 1 : -1);
    });
    return matches[0];
  }
  putApproval(a: Approval) {
    this.approvals.set(a.id, a);
  }
  conversationGeneration = 0;
  private approvalGenerations = new Map<string, number>();
  generation() {
    return this.conversationGeneration;
  }
  private latest: (LatestProposal & { generation: number }) | null = null;
  private drafted = new Set<string>();
  latestProposal(): LatestProposal | null {
    if (!this.latest || this.latest.generation !== this.conversationGeneration) return null;
    const { generation: _g, ...latest } = this.latest;
    return latest;
  }
  proposalCurrent(id: string) {
    return !this.drafted.has(id) || this.latestProposal()?.approvalId === id;
  }
  rejectSupersededProposals(generation: number): number {
    if (generation !== this.conversationGeneration) return 0;
    let closed = 0;
    for (const a of this.approvals.values()) {
      if (a.status !== "pending" || this.proposalCurrent(a.id) || this.approvalGenerations.get(a.id) !== generation) continue;
      this.approvals.set(a.id, { ...a, status: "rejected" });
      closed += 1;
    }
    return closed;
  }
  createApprovalForKey(a: Approval, generation: number, order?: ProposalOrder): Approval | null {
    if (generation !== this.conversationGeneration) return null;
    const holders = [...this.approvals.values()].filter(
      (x) => x.idempotencyKey === a.idempotencyKey && KEY_HOLDING.includes(x.status),
    );
    if (holders.length === 0) {
      this.approvals.set(a.id, a);
      this.approvalGenerations.set(a.id, generation);
      if (order) {
        this.drafted.add(a.id);
        const cur = this.latestProposal();
        if (!cur || !olderProposal(order, cur)) this.latest = { approvalId: a.id, ...order, generation };
      }
      return a;
    }
    holders.sort((x, y) => KEY_HOLDING.indexOf(x.status) - KEY_HOLDING.indexOf(y.status) || (x.createdAt < y.createdAt ? -1 : 1));
    return holders[0];
  }
  rejectApprovalsForKey(key: string, personId: string) {
    for (const a of this.approvals.values()) {
      if (a.idempotencyKey === key && a.personId === personId && a.status === "pending") {
        this.approvals.set(a.id, { ...a, status: "rejected" });
      }
    }
  }
  keyDeclined(key: string) {
    return [...this.approvals.values()].some((a) => a.idempotencyKey === key && a.status === "rejected");
  }
  private generationOf(id: string) {
    return this.approvalGenerations.get(id) ?? 0;
  }
  approvalCurrent(id: string) {
    return this.generationOf(id) === this.conversationGeneration;
  }
  approvalAuthorized(id: string) {
    return this.approvals.get(id)?.status === "approved" && this.approvalCurrent(id);
  }
  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt, guard: ConsumeGuard): Approval | null {
    const current = this.approvals.get(id);
    if (!current || current.status !== "pending") return null;
    if (!this.proposalCurrent(id)) return null;
    if (this.keyDeclined(current.idempotencyKey)) return null;
    if (this.generationOf(id) !== this.conversationGeneration) return null;
    if (current.personId !== guard.personId) return null;
    if (current.requestHash !== guard.requestHash) return null;
    if (new Date(current.expiresAt).getTime() <= Date.now()) return null;
    const prior = this.attempts.get(attempt.key);
    // The key is claimable when unused, or when a previous attempt ended
    // unknown or failed. Content must match: a different request under a
    // claimed key is rejected, never adopted.
    if (prior) {
      if (prior.status !== "unknown" && prior.status !== "failed") return null;
      if (prior.requestHash && attempt.requestHash && prior.requestHash !== attempt.requestHash) return null;
    }
    this.attempts.set(attempt.key, attempt);
    const approved: Approval = { ...current, status: "approved", approvedByHumanId: humanId };
    this.approvals.set(id, approved);
    return approved;
  }
  expireApproval(id: string) {
    return transition(this.approvals, id, "expired");
  }
  setApprovalBlocked(id: string) {
    return transition(this.approvals, id, "blocked");
  }
  markApprovalStale(id: string) {
    return transition(this.approvals, id, "stale");
  }
  setApprovalProblems(id: string, problems: string[]) {
    const current = this.approvals.get(id);
    if (current) this.approvals.set(id, { ...current, problems });
  }
  escalateApproval(id: string) {
    const current = this.approvals.get(id);
    if (!current || current.status !== "pending") return false;
    this.approvals.set(id, { ...current, escalated: true });
    return true;
  }
  getReceiptByKey(key: string) {
    return this.receipts.get(key) ?? null;
  }
  putReceipt(r: Receipt) {
    this.receipts.set(r.idempotencyKey, r);
  }
  getAttempt(key: string) {
    return this.attempts.get(key) ?? null;
  }
  insertAttempt(a: Attempt, generation?: number) {
    if (generation !== undefined && generation !== this.conversationGeneration) return false;
    if (this.attempts.has(a.key)) return false;
    this.attempts.set(a.key, a);
    return true;
  }
  adoptUnknownAttempt(key: string, now: Date) {
    return this.adoptFrom(key, "unknown", now);
  }
  adoptFailedAttempt(key: string, now: Date) {
    return this.adoptFrom(key, "failed", now);
  }
  private adoptFrom(key: string, from: Attempt["status"], now: Date) {
    const current = this.attempts.get(key);
    if (!current || current.status !== from) return false;
    this.attempts.set(key, { ...current, status: "in_flight", updatedAt: now.toISOString() });
    return true;
  }
  adoptForRecoveryIfApprovalLive(key: string, now: Date) {
    const current = this.attempts.get(key);
    if (!current || (current.status !== "unknown" && current.status !== "in_flight")) return false;
    const live = [...this.approvals.values()].some(
      (a) =>
        a.idempotencyKey === key &&
        a.status === "approved" &&
        this.generationOf(a.id) === this.conversationGeneration &&
        new Date(a.expiresAt).getTime() > now.getTime(),
    );
    if (!live) return false;
    this.attempts.set(key, { ...current, status: "in_flight", updatedAt: now.toISOString() });
    return true;
  }
  claimRecoverableAttempt(key: string, olderThanIso: string, now: Date) {
    const current = this.attempts.get(key);
    if (!current) return false;
    if (current.status !== "in_flight" && current.status !== "unknown") return false;
    if (current.updatedAt >= olderThanIso) return false;
    this.attempts.set(key, { ...current, updatedAt: now.toISOString() });
    return true;
  }
  listRecoverableAttempts(olderThanIso: string) {
    return [...this.attempts.values()].filter(
      (a) => (a.status === "in_flight" || a.status === "unknown") && a.updatedAt < olderThanIso,
    );
  }
  hasUnresolvedAttempts() {
    return [...this.attempts.values()].some((a) => a.status === "in_flight" || a.status === "unknown");
  }
  updateAttempt(key: string, status: Attempt["status"]) {
    const current = this.attempts.get(key);
    if (current) this.attempts.set(key, { ...current, status, updatedAt: new Date().toISOString() });
  }
  audit<const T extends { event: string }>(entry: T & AuditEntry<T>) {
    this.auditLog.push(entry);
  }
}

// Server-side document bytes. The agent implementation reads from R2;
// tests use MapDocumentStore. The caller's copy is never trusted.
export interface DocumentStore {
  getBytes(documentId: string): Promise<Uint8Array | string | null>;
}

export class MapDocumentStore implements DocumentStore {
  constructor(private docs = new Map<string, Uint8Array | string>()) {}
  set(documentId: string, content: Uint8Array | string) {
    this.docs.set(documentId, content);
  }
  async getBytes(documentId: string): Promise<Uint8Array | string | null> {
    return this.docs.get(documentId) ?? null;
  }
}

export type LinkCheckFn = (
  url: string,
  opts: { forDisplay: boolean },
) => Promise<{ allowed: boolean; reason?: LinkBlockReason }>;

const defaultLinkCheck: LinkCheckFn = (url, opts) =>
  checkLinkSafety(url, { forDisplay: opts.forDisplay });

export interface GatewayOptions {
  policyOverrides?: Partial<Record<string, PolicyDecision>>;
  checker?: Checker;
  checkerTimeoutMs?: number;
  documents?: DocumentStore;
  linkCheck?: LinkCheckFn;
  listConsents?: () => { recipient: string; purpose: string }[];
}

// Every URL the action could touch: the recipient plus every URL anywhere
// in the payload, including links inside message text and nested objects.
// The gateway checks all of them before acting.
export function collectActionUrls(req: ActionRequest): string[] {
  const urls = new Set<string>();
  const pushText = (value: string) => {
    if (/^https?:\/\//i.test(value.trim())) urls.add(value.trim());
    for (const found of extractHttpUrls(value)) urls.add(found);
  };
  const walk = (value: unknown) => {
    if (typeof value === "string") pushText(value);
    else if (Array.isArray(value)) for (const entry of value) walk(entry);
    else if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  pushText(req.recipient);
  walk(req.payload);
  return [...urls];
}

// Hash of the canonical request, excluding gateway-attached document
// bytes. Attempts and receipts carry it so reuse of a key with different
// content is rejected.
export async function contentHashOf(req: ActionRequest): Promise<string> {
  const { document: _attached, ...rest } = req;
  return sha256Hex(canonicalJson(rest));
}

export interface FrozenRequest {
  requestJson: string;
  requestHash: string;
  documentHash: string | null;
}

// Freezes a validated request: canonical JSON executed verbatim on approval,
// plus a hash binding type, recipient, purpose, payload, person,
// idempotency key and document bytes.
export async function freezeActionRequest(
  req: ActionRequest,
  documentBytes: Uint8Array | string | null,
): Promise<FrozenRequest> {
  let documentB64: string | null = null;
  let documentHash: string | null = null;
  if (documentBytes != null) {
    const raw = typeof documentBytes === "string" ? new TextEncoder().encode(documentBytes) : documentBytes;
    documentHash = await sha256Hex(raw);
    documentB64 = bytesToBase64(raw);
  }
  const fingerprint = {
    type: req.type,
    recipient: req.recipient,
    purpose: req.purpose,
    payload: req.payload,
    document: documentB64,
    personId: req.personId,
    idempotencyKey: req.idempotencyKey,
  };
  return {
    requestJson: canonicalJson(req),
    requestHash: await sha256Hex(fingerprintToJson(fingerprint)),
    documentHash,
  };
}

function fingerprintToJson(fingerprint: Record<string, unknown>): string {
  return canonicalJson(fingerprint);
}

function approvalGoneReason(status: Approval["status"]): string {
  const reasons: Record<Approval["status"], string> = {
    pending: "This approval is still pending.",
    approved: "This approval was already used.",
    rejected: "This approval was declined.",
    revoked: "This approval was revoked when the conversation was deleted.",
    stale: "This approval is stale: the request changed after it was created.",
    blocked: "This approval is blocked.",
    expired: "Approval expired.",
  };
  return reasons[status];
}

// The outcome of one reconcile lookup. Settled carries a receipt-backed
// result; absent means the caller may adopt the key and execute; a throw
// inside check becomes unavailable, which keeps the attempt unknown.
// Nothing was written: the conversation was deleted after the request was
// prepared, so the request belongs to a conversation that no longer exists.
export const STALE: GatewayResult = {
  status: "blocked",
  reason: "This conversation was deleted after the request was prepared. Nothing was done.",
};

// Refused: a newer drafted proposal replaced this one.
export const SUPERSEDED: GatewayResult = { status: "blocked", reason: SUPERSEDED_REASON, superseded: true };

// Audit digests for one approval, computed before any check or claim.
type AuditHashes = { key: AuditDigest; approval: AuditDigest };

type ReconcileOutcome =
  | { kind: "settled"; result: GatewayResult }
  | { kind: "absent" }
  | { kind: "unavailable"; result: GatewayResult };

export class ActionGateway {
  private checker: Checker;
  private checkerTimeoutMs: number;
  private documents: DocumentStore;
  private linkCheck: LinkCheckFn;
  private listConsents: () => { recipient: string; purpose: string }[];

  constructor(
    private store: ApprovalStore,
    private executor: Executor,
    private opts: GatewayOptions = {},
  ) {
    this.checker = opts.checker ?? new LocalRulesChecker();
    this.checkerTimeoutMs = opts.checkerTimeoutMs ?? 5000;
    this.documents = opts.documents ?? new MapDocumentStore();
    this.linkCheck = opts.linkCheck ?? defaultLinkCheck;
    this.listConsents = opts.listConsents ?? (() => []);
  }

  private async runChecker(
    req: ActionRequest,
    documentHash: string | null,
  ): Promise<{ ok: true; problems: string[] } | { ok: false; reason: string }> {
    let result: CheckResult;
    try {
      result = await checkerWithTimeout(this.checker, this.checkerTimeoutMs).check({
        action: {
          type: req.type,
          recipient: req.recipient,
          purpose: req.purpose,
          payload: req.payload,
          documentHash,
        },
        sources: req.sources ?? [],
        consents: this.listConsents(),
        origin: req.origin ?? "person",
      });
    } catch (err) {
      this.store.audit({ event: "gateway.checker_error", detailHash: await auditDigest(String(err)) });
      return { ok: false, reason: "Blocked by review: the checker failed and the gateway fails closed." };
    }
    if (result.verdict === "pass") return { ok: true, problems: [] };
    const reason = `Blocked by review: ${result.problems.join("; ") || "no detail"}`;
    if (result.verdict === "block") return { ok: false, reason };
    return { ok: true, problems: result.problems };
  }

  private async checkLinks(req: ActionRequest): Promise<GatewayResult | null> {
    for (const url of collectActionUrls(req)) {
      const verdict = await this.linkCheck(url, { forDisplay: false });
      if (!verdict.allowed) {
        this.store.audit({ event: "gateway.link_block", urlHash: await auditDigest(url), reason: verdict.reason });
        return { status: "blocked", reason: `Blocked before acting: link check failed for ${url}: ${verdict.reason ?? "blocked"}` };
      }
    }
    return null;
  }

  private async readDocumentBytes(documentId: string | undefined): Promise<
    | { ok: true; bytes: Uint8Array | string | null }
    | { ok: false; result: GatewayResult }
  > {
    if (!documentId) return { ok: true, bytes: null };
    let bytes: Uint8Array | string | null;
    try {
      bytes = await this.documents.getBytes(documentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        result: { status: "blocked", reason: `Document storage is unavailable: ${message}` },
      };
    }
    if (bytes == null) {
      return {
        ok: false,
        result: { status: "blocked", reason: `Document ${documentId} was not found on the server.` },
      };
    }
    return { ok: true, bytes };
  }

  // Attaches verified server-side bytes to the request the executor runs,
  // so the approved document reaches the destination.
  private enrichWithDocument(
    req: ActionRequest,
    bytes: Uint8Array | string | null,
    documentHash: string | null,
  ): ActionRequest {
    if (bytes == null || !documentHash) return req;
    const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    return { ...req, document: { bytesB64: bytesToBase64(raw), hash: documentHash } };
  }

  private receiptReuse(req: ActionRequest, contentHash: string, keyHash: AuditDigest): GatewayResult | null {
    const existing = this.store.getReceiptByKey(req.idempotencyKey);
    if (!existing) return null;
    if (existing.requestHash && existing.requestHash !== contentHash) {
      this.store.audit({ event: "gateway.key_reuse", keyHash });
      return { status: "blocked", reason: "This idempotency key was already used with different content." };
    }
    return { status: "completed", receipt: existing };
  }

  // generation is the conversation generation the caller prepared this
  // request under; without one, the current generation when it arrives.
  // The approval insert and the execution claim commit only while it is
  // still current, re-checked at the write itself.
  async requestAction(raw: unknown, now = new Date(), opts: { generation?: number; proposal?: ProposalOrder } = {}): Promise<GatewayResult> {
    const generation = opts.generation ?? this.store.generation();
    if (generation !== this.store.generation()) return STALE;
    let req: ActionRequest;
    try {
      req = parseActionRequest(raw);
    } catch (err) {
      const detail = err instanceof ValidationError ? err.message : "unreadable request";
      this.store.audit({ event: "gateway.invalid", detailHash: await auditDigest(detail) });
      return { status: "blocked", reason: `Invalid action request: ${detail}` };
    }
    const keyHash = await auditDigest(req.idempotencyKey);
    this.store.audit({ event: "gateway.decide", type: req.type, keyHash });
    const contentHash = await contentHashOf(req);
    const replay = this.receiptReuse(req, contentHash, keyHash);
    if (replay) return replay;

    const decision = evaluatePolicy(req, this.opts.policyOverrides as never);
    if (decision === "block") {
      this.store.audit({ event: "gateway.block", type: req.type, reason: "policy" });
      return { status: "blocked", reason: "Policy blocks this action." };
    }

    const docRead = await this.readDocumentBytes(req.documentId);
    if (!docRead.ok) return docRead.result;

    const linkBlock = await this.checkLinks(req);
    if (linkBlock) return linkBlock;

    if (decision === "ask") {
      const frozen = await freezeActionRequest(req, docRead.bytes);
      const check = await this.runChecker(req, frozen.documentHash);
      if (!check.ok) {
        this.store.audit({ event: "gateway.block", type: req.type, reason: "checker" });
        return { status: "blocked", reason: check.reason };
      }
      const win = approvalWindow(now, req.deadlineAt);
      const approval: Approval = {
        id: crypto.randomUUID(),
        actionType: req.type,
        recipient: req.recipient,
        purpose: req.purpose,
        documentHash: frozen.documentHash,
        documentId: req.documentId ?? null,
        idempotencyKey: req.idempotencyKey,
        status: "pending",
        approvedByHumanId: null,
        personId: req.personId,
        requestJson: frozen.requestJson,
        requestHash: frozen.requestHash,
        problems: check.problems,
        createdAt: win.createdAt.toISOString(),
        remindAt: win.remindAt.toISOString(),
        expiresAt: win.expiresAt.toISOString(),
        escalated: win.escalated,
      };
      const holder = this.store.createApprovalForKey(approval, generation, opts.proposal);
      if (!holder) return STALE;
      if (holder.id === approval.id) return { status: "needs_approval", approval };
      if (holder.status === "rejected") return { status: "blocked", reason: approvalGoneReason("rejected") };
      if (holder.requestHash !== approval.requestHash || holder.personId !== approval.personId) {
        this.store.audit({ event: "gateway.key_reuse", keyHash });
        return { status: "blocked", reason: "This idempotency key was already used with different content." };
      }
      // A retry of the same action: the person answers the approval they
      // already have, never a second one.
      if (holder.status === "pending") return { status: "needs_approval", approval: holder };
      return { status: "blocked", reason: "This action was already approved. Approve it again to retry it." };
    }

    const frozen = await freezeActionRequest(req, docRead.bytes);
    const check = await this.runChecker(req, frozen.documentHash);
    if (!check.ok) return { status: "blocked", reason: check.reason };
    if (check.problems.length > 0) {
      // A fix verdict needs a person to review; the allow path has none.
      return { status: "blocked", reason: `Blocked by review: ${check.problems.join("; ")}` };
    }
    return this.execute(this.enrichWithDocument(req, docRead.bytes, frozen.documentHash), now, generation);
  }

  // A person's NO. Ends the action at once: every pending approval under
  // its key is rejected in one step, and the key stays declined, so no
  // retry or duplicate can run it. Guarded on pending, so it races safely
  // with an approve: whichever reaches the row first wins. A second NO on
  // a declined approval answers the same.
  async rejectApproval(approvalId: string, humanId: string): Promise<GatewayResult> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { status: "blocked", reason: "Approval not found." };
    if (!humanId || humanId !== approval.personId) {
      return { status: "blocked", reason: "This approval belongs to a different person." };
    }
    const approvalHash = await auditDigest(approval.id);
    if (approval.status === "pending" || approval.status === "rejected") {
      this.store.rejectApprovalsForKey(approval.idempotencyKey, approval.personId);
    }
    const fresh = this.store.getApproval(approval.id) ?? approval;
    if (fresh.status !== "rejected") return { status: "blocked", reason: approvalGoneReason(fresh.status) };
    this.store.audit({ event: "gateway.reject", approvalHash });
    return { status: "rejected", approval: fresh };
  }

  async approveAndExecute(
    approvalId: string,
    humanId: string,
    now = new Date(),
  ): Promise<GatewayResult> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { status: "blocked", reason: "Approval not found." };
    if (this.store.keyDeclined(approval.idempotencyKey)) return { status: "blocked", reason: approvalGoneReason("rejected") };
    if (approval.status === "pending" && !this.store.approvalCurrent(approval.id)) return STALE;
    if (approval.status === "pending" && !this.store.proposalCurrent(approval.id)) return SUPERSEDED;
    // Every audit digest is computed here, before any expiry check or
    // claim, so nothing awaits between the final claim and execute.
    const hashes: AuditHashes = {
      key: await auditDigest(approval.idempotencyKey),
      approval: await auditDigest(approval.id),
    };
    // Consumed approvals retry first, whatever the expiry: their attempt
    // always reconciles, and expiry only stops new execution (see
    // retryConsumedApproval, which reconciles before any expiry decision).
    if (approval.status !== "pending") {
      if (approval.status === "approved" && approval.approvedByHumanId === humanId) {
        return this.retryConsumedApproval(approval, humanId, now, hashes);
      }
      return { status: "blocked", reason: approvalGoneReason(approval.status) };
    }
    if (new Date(approval.expiresAt).getTime() < now.getTime()) {
      // Guarded: a no-op unless the row is still pending, so this write
      // can never clobber a concurrent consume.
      this.store.expireApproval(approvalId);
      const fresh = this.store.getApproval(approvalId);
      return { status: "blocked", reason: approvalGoneReason(fresh?.status ?? "expired") };
    }
    if (!humanId || humanId !== approval.personId) {
      return { status: "blocked", reason: "This approval belongs to a different person." };
    }
    let stored: ActionRequest;
    try {
      stored = parseActionRequest(JSON.parse(approval.requestJson));
    } catch {
      return { status: "blocked", reason: "Approval data is unreadable." };
    }
    if (evaluatePolicy(stored, this.opts.policyOverrides as never) === "block") {
      this.store.setApprovalBlocked(approvalId);
      this.store.audit({ event: "gateway.block", type: stored.type, reason: "policy-rerun" });
      return { status: "blocked", reason: "Policy now blocks this action." };
    }
    const linkBlock = await this.checkLinks(stored);
    if (linkBlock) return linkBlock;
    const docRead = await this.readDocumentBytes(stored.documentId);
    if (!docRead.ok) return docRead.result;
    const frozen = await freezeActionRequest(stored, docRead.bytes);
    const check = await this.runChecker(stored, frozen.documentHash);
    if (!check.ok) return { status: "blocked", reason: check.reason };
    if (frozen.requestHash !== approval.requestHash) {
      this.store.markApprovalStale(approvalId);
      this.store.audit({ event: "gateway.stale_block", approvalHash: hashes.approval });
      const fresh = this.store.getApproval(approvalId);
      return { status: "stale", approval: fresh ?? approval, reason: "Document changed after approval." };
    }
    if (check.problems.length > 0) {
      // Field-only: the status column is untouched, so a fix verdict that
      // lands after an expiry or a concurrent consume cannot revive this
      // approval.
      this.store.setApprovalProblems(approvalId, check.problems);
    }
    // An unknown attempt must reconcile to a definite answer before any
    // new execution, on the approve path as well as the allow path. The
    // content check comes first: a different action reusing this key must
    // never reconcile (or adopt) the original attempt.
    const prior = this.store.getAttempt(stored.idempotencyKey);
    if (prior?.status === "unknown") {
      if (prior.requestHash && prior.requestHash !== (await contentHashOf(stored))) {
        this.store.audit({ event: "gateway.key_reuse", keyHash: hashes.key });
        return { status: "blocked", reason: "This idempotency key was already used with different content." };
      }
      const settled = await this.reconcileUnknown(stored, now, hashes.key);
      if (settled.kind !== "absent") return settled.result;
    }
    const attempt: Attempt = {
      key: stored.idempotencyKey,
      status: "in_flight",
      updatedAt: now.toISOString(),
      requestHash: await contentHashOf(stored),
      actionType: stored.type,
      recipient: stored.recipient,
      personId: stored.personId,
    };
    const consumed = this.store.consumeApprovalAndClaim(approvalId, humanId, attempt, {
      personId: approval.personId,
      requestHash: approval.requestHash,
    });
    if (!consumed) {
      if (this.store.keyDeclined(approval.idempotencyKey)) return { status: "blocked", reason: approvalGoneReason("rejected") };
      if (!this.store.approvalCurrent(approvalId)) return STALE;
      if (!this.store.proposalCurrent(approvalId)) return SUPERSEDED;
      const fresh = this.store.getApproval(approvalId);
      // The claim reads a fresh clock, so a window that lapsed during
      // the awaits above lands here: report expiry, not a phantom race.
      if (fresh && new Date(fresh.expiresAt).getTime() < Date.now()) {
        this.store.expireApproval(approvalId);
        return { status: "blocked", reason: "Approval expired." };
      }
      if (fresh?.status === "pending") {
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      return { status: "blocked", reason: approvalGoneReason(fresh?.status ?? approval.status) };
    }
    return this.runExecution(this.enrichWithDocument(stored, docRead.bytes, frozen.documentHash), now, hashes.key);
  }

  // Retries a consumed approval without asking the person again. Failed
  // attempts rerun cleanly; unknown attempts reconcile first, and only an
  // absent outcome re-executes. Every check runs again either way.
  private async retryConsumedApproval(
    approval: Approval,
    humanId: string,
    now: Date,
    hashes: AuditHashes,
  ): Promise<GatewayResult> {
    let stored: ActionRequest;
    try {
      stored = parseActionRequest(JSON.parse(approval.requestJson));
    } catch {
      return { status: "blocked", reason: "Approval data is unreadable." };
    }
    if (evaluatePolicy(stored, this.opts.policyOverrides as never) === "block") {
      return { status: "blocked", reason: "Policy now blocks this action." };
    }
    const linkBlock = await this.checkLinks(stored);
    if (linkBlock) return linkBlock;
    const docRead = await this.readDocumentBytes(stored.documentId);
    if (!docRead.ok) return docRead.result;
    const frozen = await freezeActionRequest(stored, docRead.bytes);
    const check = await this.runChecker(stored, frozen.documentHash);
    if (!check.ok) return { status: "blocked", reason: check.reason };
    if (frozen.requestHash !== approval.requestHash) {
      this.store.audit({ event: "gateway.stale_block", approvalHash: hashes.approval });
      return { status: "stale", approval, reason: "Document changed after approval." };
    }
    const attempt = this.store.getAttempt(approval.idempotencyKey);
    if (!attempt) {
      return { status: "blocked", reason: "This approval has no recorded attempt. Refusing to execute." };
    }
    // Reconcile before any expiry decision: if the action happened, the
    // person gets the receipt even after the window passed.
    if (attempt.status === "unknown") {
      const settled = await this.reconcileUnknown(stored, now, hashes.key);
      if (settled.kind !== "absent") return settled.result;
    }
    // From here to execute nothing awaits: a window that is open at this
    // check is still open when the executor starts.
    if (new Date(approval.expiresAt).getTime() < Date.now()) {
      return { status: "blocked", reason: "Approval expired." };
    }
    if (this.store.keyDeclined(approval.idempotencyKey)) {
      return { status: "blocked", reason: approvalGoneReason("rejected") };
    }
    // Synchronous with the adopt below: a delete during the awaits above
    // revoked this approval or moved the generation, and it cannot run.
    if (!this.store.approvalAuthorized(approval.id)) return { status: "blocked", reason: approvalGoneReason("revoked") };
    if (check.problems.length > 0) this.store.setApprovalProblems(approval.id, check.problems);
    if (attempt.status === "failed" || attempt.status === "unknown") {
      const adopt =
        attempt.status === "failed"
          ? this.store.adoptFailedAttempt(approval.idempotencyKey, now)
          : this.store.adoptUnknownAttempt(approval.idempotencyKey, now);
      if (!adopt) {
        const receipt = this.store.getReceiptByKey(approval.idempotencyKey);
        if (receipt) return { status: "completed", receipt };
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      this.store.audit({ event: "gateway.retry_consumed", keyHash: hashes.key, from: attempt.status });
      return this.runExecution(this.enrichWithDocument(stored, docRead.bytes, frozen.documentHash), now, hashes.key);
    }
    if (attempt.status === "in_flight") {
      return { status: "in_progress", reason: "Another request with this idempotency key is running." };
    }
    // Done or otherwise settled: one approval authorizes one action, so a
    // second approve is refused even though the receipt still exists.
    return { status: "blocked", reason: approvalGoneReason(approval.status) };
  }

  private async makeReceipt(
    req: ActionRequest,
    status: Receipt["status"],
    externalId: string,
    simulated: boolean | undefined,
    now: Date,
    // The persisted original attempt. Reconciled receipts are built from
    // it, never from whichever request triggered the lookup.
    attempt?: Attempt | null,
  ): Promise<Receipt> {
    return {
      id: crypto.randomUUID(),
      idempotencyKey: req.idempotencyKey,
      actionType: attempt?.actionType ?? req.type,
      recipient: attempt?.recipient ?? req.recipient,
      status,
      externalId,
      simulated: simulated ?? (req.type === "share" ? false : this.executor.simulated),
      requestHash: attempt?.requestHash || (await contentHashOf(req)),
      createdAt: now.toISOString(),
    };
  }

  // Reconciles an unknown attempt. Found settles with a receipt built
  // from the persisted attempt row; confirmed absent lets the caller
  // adopt the key and execute; an unreachable executor keeps the attempt
  // unknown and blocks. A failed lookup is never treated as "did not
  // happen".
  private async reconcileUnknown(req: ActionRequest, now: Date, keyHash: AuditDigest): Promise<ReconcileOutcome> {
    let outcome: { found: true; externalId: string } | { found: false };
    try {
      outcome = await this.executor.check(req.idempotencyKey, req.personId);
    } catch (err) {
      this.store.audit({ event: "gateway.check_error", keyHash, detailHash: await auditDigest(String(err)) });
      return {
        kind: "unavailable",
        result: {
          status: "blocked",
          reason:
            "The gateway cannot reach the outside system to reconcile this action, so it stays unknown. " +
            "Try again later with the same idempotency key.",
        },
      };
    }
    if (outcome.found) {
      const attempt = this.store.getAttempt(req.idempotencyKey);
      const receipt = await this.makeReceipt(req, "reconciled", outcome.externalId, undefined, now, attempt);
      this.store.putReceipt(receipt);
      this.store.updateAttempt(req.idempotencyKey, "done");
      this.store.audit({ event: "gateway.reconciled", keyHash });
      return { kind: "settled", result: { status: "reconciled", receipt } };
    }
    return { kind: "absent" };
  }

  // With a generation, every claim below commits only while it is current.
  async execute(req: ActionRequest, now = new Date(), generation?: number): Promise<GatewayResult> {
    const stale = () => generation !== undefined && generation !== this.store.generation();
    const keyHash = await auditDigest(req.idempotencyKey);
    const contentHash = await contentHashOf(req);
    const replay = this.receiptReuse(req, contentHash, keyHash);
    if (replay) return replay;
    const attempt = this.store.getAttempt(req.idempotencyKey);
    if (attempt?.requestHash && attempt.requestHash !== contentHash) {
      this.store.audit({ event: "gateway.key_reuse", keyHash });
      return { status: "blocked", reason: "This idempotency key was already used with different content." };
    }
    if (attempt?.status === "in_flight") {
      return { status: "in_progress", reason: "Another request with this idempotency key is running." };
    }
    if (attempt?.status === "unknown") {
      const settled = await this.reconcileUnknown(req, now, keyHash);
      if (settled.kind !== "absent") return settled.result;
      if (stale()) return STALE;
      if (!this.store.adoptUnknownAttempt(req.idempotencyKey, now)) {
        const receipt = this.store.getReceiptByKey(req.idempotencyKey);
        if (receipt) return { status: "completed", receipt };
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      return this.runExecution(req, now, keyHash);
    }
    if (attempt?.status === "failed") {
      // Definite failure: nothing happened, so no reconcile is needed
      // before the clean retry.
      if (stale()) return STALE;
      if (!this.store.adoptFailedAttempt(req.idempotencyKey, now)) {
        const receipt = this.store.getReceiptByKey(req.idempotencyKey);
        if (receipt) return { status: "completed", receipt };
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      return this.runExecution(req, now, keyHash);
    }
    if (attempt?.status === "done") {
      // Invariant: done always ships with a receipt, which the check above
      // would have returned. If it is missing anyway, reconcile once and
      // otherwise fail closed rather than executing blindly.
      const settled = await this.reconcileUnknown(req, now, keyHash);
      if (settled.kind !== "absent") return settled.result;
      this.store.audit({ event: "gateway.corrupt_attempt", keyHash });
      return { status: "blocked", reason: "This key has a recorded attempt but no receipt. Refusing to execute." };
    }
    const fresh: Attempt = {
      key: req.idempotencyKey,
      status: "in_flight",
      updatedAt: now.toISOString(),
      requestHash: contentHash,
      actionType: req.type,
      recipient: req.recipient,
      personId: req.personId,
    };
    if (!this.store.insertAttempt(fresh, generation)) {
      if (stale()) return STALE;
      const receipt = this.store.getReceiptByKey(req.idempotencyKey);
      if (receipt) return { status: "completed", receipt };
      return { status: "in_progress", reason: "Another request with this idempotency key is running." };
    }
    return this.runExecution(req, now, keyHash);
  }

  // Recovers one unresolved attempt (in_flight or unknown): older than
  // the cutoff, so no live request can still own it. Approve-path
  // attempts re-verify against the stored request and run without asking
  // the person again; allow-path attempts reconcile only, since no
  // request is stored. Returns null when another recovery claimed the
  // key first.
  async recoverAttempt(key: string, now: Date, olderThanIso: string): Promise<GatewayResult | null> {
    const attempt = this.store.getAttempt(key);
    if (!attempt || (attempt.status !== "in_flight" && attempt.status !== "unknown")) return null;
    if (attempt.updatedAt >= olderThanIso) return null;
    const keyHash = await auditDigest(key);
    if (!this.store.claimRecoverableAttempt(key, olderThanIso, now)) return null;
    this.store.audit({ event: "gateway.recover_claimed", keyHash });
    const approval = this.store.getApprovalByKey(key);
    if (!approval) return this.recoverAllowAttempt(key, attempt, now, keyHash);
    const approvalHash = await auditDigest(approval.id);
    let stored: ActionRequest;
    try {
      stored = parseActionRequest(JSON.parse(approval.requestJson));
    } catch {
      this.store.updateAttempt(key, "failed");
      this.store.audit({ event: "gateway.recover_corrupt", keyHash });
      return { status: "blocked", reason: "The stored request for this key is unreadable." };
    }
    // Reconcile before any expiry decision: if the action happened, the
    // person gets the receipt even after the window passed.
    const settled = await this.reconcileUnknown(stored, now, keyHash);
    if (settled.kind !== "absent") return settled.result;
    if (new Date(approval.expiresAt).getTime() < Date.now()) {
      this.store.updateAttempt(key, "failed");
      return { status: "blocked", reason: "Approval expired before the stranded attempt could be recovered." };
    }
    if (evaluatePolicy(stored, this.opts.policyOverrides as never) === "block") {
      this.store.updateAttempt(key, "failed");
      return { status: "blocked", reason: "Policy now blocks this action." };
    }
    const linkBlock = await this.checkLinks(stored);
    if (linkBlock) {
      this.store.updateAttempt(key, "failed");
      return linkBlock;
    }
    const docRead = await this.readDocumentBytes(stored.documentId);
    if (!docRead.ok) {
      // Storage may be briefly down; the fresh timestamp keeps this key
      // out of the next recovery sweep until it ages again.
      return { status: "blocked", reason: `${docRead.result.reason ?? "Document unavailable."} Recovery will retry.` };
    }
    const frozen = await freezeActionRequest(stored, docRead.bytes);
    if (frozen.requestHash !== approval.requestHash) {
      this.store.updateAttempt(key, "failed");
      this.store.audit({ event: "gateway.stale_block", approvalHash });
      return { status: "stale", approval, reason: "Document changed after approval." };
    }
    const check = await this.runChecker(stored, frozen.documentHash);
    if (!check.ok) {
      this.store.updateAttempt(key, "failed");
      return { status: "blocked", reason: check.reason };
    }
    if (check.problems.length > 0) this.store.setApprovalProblems(approval.id, check.problems);
    // The window can lapse during the awaited checks above, so approval
    // liveness is re-verified here, in the same step that claims the key
    // for execution, with a fresh clock. Only then may it execute.
    if (this.store.keyDeclined(key)) {
      this.store.updateAttempt(key, "failed");
      return { status: "blocked", reason: approvalGoneReason("rejected") };
    }
    if (!this.store.adoptForRecoveryIfApprovalLive(key, new Date())) {
      const receipt = this.store.getReceiptByKey(key);
      if (receipt) return { status: "completed", receipt };
      this.store.updateAttempt(key, "failed");
      this.store.audit({ event: "gateway.recover_expired", keyHash });
      return { status: "blocked", reason: "Approval expired before the stranded attempt could be recovered." };
    }
    return this.runExecution(this.enrichWithDocument(stored, docRead.bytes, frozen.documentHash), now, keyHash);
  }

  private async recoverAllowAttempt(key: string, attempt: Attempt, now: Date, keyHash: AuditDigest): Promise<GatewayResult> {
    // No stored request exists on the allow path, so recovery reconciles
    // only: found settles with a receipt built from the attempt row,
    // absent marks the key failed so a fresh request retries cleanly.
    let outcome: { found: true; externalId: string } | { found: false };
    try {
      outcome = await this.executor.check(key, attempt.personId);
    } catch (err) {
      this.store.audit({ event: "gateway.check_error", keyHash, detailHash: await auditDigest(String(err)) });
      return {
        status: "blocked",
        reason: "The gateway cannot reach the outside system to reconcile this action. Recovery will retry.",
      };
    }
    if (outcome.found) {
      const receipt: Receipt = {
        id: crypto.randomUUID(),
        idempotencyKey: key,
        actionType: attempt.actionType,
        recipient: attempt.recipient,
        status: "reconciled",
        externalId: outcome.externalId,
        simulated: attempt.actionType === "share" ? false : this.executor.simulated,
        requestHash: attempt.requestHash,
        createdAt: now.toISOString(),
      };
      this.store.putReceipt(receipt);
      this.store.updateAttempt(key, "done");
      this.store.audit({ event: "gateway.reconciled", keyHash });
      return { status: "reconciled", receipt };
    }
    this.store.updateAttempt(key, "failed");
    this.store.audit({ event: "gateway.recover_absent", keyHash });
    return { status: "blocked", reason: "The outside system has no record of this key. Send the action again." };
  }

  // Runs the executor for an already-claimed (in_flight) attempt.
  private async runExecution(req: ActionRequest, now: Date, keyHash: AuditDigest): Promise<GatewayResult> {
    try {
      const out = await this.executor.execute(req);
      const receipt = await this.makeReceipt(req, "completed", out.externalId, out.simulated, now);
      this.store.putReceipt(receipt);
      this.store.updateAttempt(req.idempotencyKey, "done");
      this.store.audit({ event: "gateway.executed", keyHash });
      return { status: "completed", receipt };
    } catch (err) {
      if (err instanceof TimeoutError || (err as Error)?.name === "TimeoutError") {
        const settled = await this.reconcileUnknown(req, now, keyHash);
        if (settled.kind === "settled") return settled.result;
        this.store.updateAttempt(req.idempotencyKey, "unknown");
        if (settled.kind === "unavailable") return settled.result;
        this.store.audit({ event: "gateway.unknown", keyHash });
        return {
          status: "blocked",
          reason: "The action timed out and its outcome is unknown. Retry with the same idempotency key; the gateway reconciles before executing again.",
        };
      }
      if (err instanceof DefiniteFailureError || (err as Error)?.name === "DefiniteFailureError") {
        const message = err instanceof Error ? err.message : String(err);
        this.store.updateAttempt(req.idempotencyKey, "failed");
        this.store.audit({ event: "gateway.executor_failed", keyHash, detailHash: await auditDigest(message) });
        return { status: "blocked", reason: `The action failed before anything happened: ${message} Retry with the same idempotency key.` };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateAttempt(req.idempotencyKey, "unknown");
      this.store.audit({ event: "gateway.executor_error", keyHash, detailHash: await auditDigest(message) });
      return { status: "blocked", reason: `The action failed before a receipt was recorded: ${message}` };
    }
  }
}
