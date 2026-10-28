import { canonicalJson } from "@mano/protocol";
import { sha256Hex, bytesToBase64 } from "../hash.js";
import { checkLinkSafety, extractHttpUrls } from "../link-safety.js";
import { approvalWindow, evaluatePolicy } from "./policy.js";
import type {
  ActionRequest,
  Approval,
  Attempt,
  Executor,
  GatewayResult,
  PolicyDecision,
  Receipt,
} from "./types.js";
import { DefiniteFailureError, TimeoutError } from "./types.js";
import { ValidationError, parseActionRequest } from "./validate.js";
import { LocalRulesChecker, checkerWithTimeout, type Checker, type CheckResult } from "./checker.js";

// Guard re-checked inside the consuming statement: the approval must still
// be pending, owned by this person, bound to this request hash, and
// unexpired at the moment of consumption.
export interface ConsumeGuard {
  personId: string;
  requestHash: string;
  now: Date;
}

export interface ApprovalStore {
  getApproval(id: string): Approval | null;
  // The approval behind an idempotency key, preferring the consumed one.
  // More than one approval can share a key; recovery wants the one that
  // claimed the attempt.
  getApprovalByKey(key: string): Approval | null;
  putApproval(a: Approval): void;
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
  insertAttempt(a: Attempt): boolean;
  // Compare-and-set: moves an unknown attempt back to in_flight so a retry
  // can adopt the key. False unless the attempt exists and is unknown.
  adoptUnknownAttempt(key: string, now: Date): boolean;
  // Compare-and-set for clean retries: moves a failed attempt back to
  // in_flight. False unless the attempt exists and is failed.
  adoptFailedAttempt(key: string, now: Date): boolean;
  // Claims a stranded in_flight attempt for recovery: refreshes its
  // timestamp so a second recovery cannot claim it too.
  claimStaleAttempt(key: string, olderThanIso: string, now: Date): boolean;
  listStaleAttempts(olderThanIso: string): Attempt[];
  updateAttempt(key: string, status: Attempt["status"]): void;
  audit(entry: Record<string, unknown>): void;
}

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
  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt, guard: ConsumeGuard): Approval | null {
    const current = this.approvals.get(id);
    if (!current || current.status !== "pending") return null;
    if (current.personId !== guard.personId) return null;
    if (current.requestHash !== guard.requestHash) return null;
    if (new Date(current.expiresAt).getTime() <= guard.now.getTime()) return null;
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
  insertAttempt(a: Attempt) {
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
  claimStaleAttempt(key: string, olderThanIso: string, now: Date) {
    const current = this.attempts.get(key);
    if (!current || current.status !== "in_flight" || current.updatedAt >= olderThanIso) return false;
    this.attempts.set(key, { ...current, updatedAt: now.toISOString() });
    return true;
  }
  listStaleAttempts(olderThanIso: string) {
    return [...this.attempts.values()].filter((a) => a.status === "in_flight" && a.updatedAt < olderThanIso);
  }
  updateAttempt(key: string, status: Attempt["status"]) {
    const current = this.attempts.get(key);
    if (current) this.attempts.set(key, { ...current, status, updatedAt: new Date().toISOString() });
  }
  audit(entry: Record<string, unknown>) {
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
) => Promise<{ allowed: boolean; reason?: string }>;

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
    stale: "This approval is stale: the request changed after it was created.",
    blocked: "This approval is blocked.",
    expired: "Approval expired.",
  };
  return reasons[status];
}

// The outcome of one reconcile lookup. Settled carries a receipt-backed
// result; absent means the caller may adopt the key and execute; a throw
// inside check becomes unavailable, which keeps the attempt unknown.
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
      this.store.audit({ event: "gateway.checker_error", detail: String(err) });
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
        this.store.audit({ event: "gateway.link_block", url, reason: verdict.reason });
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

  private receiptReuse(req: ActionRequest, contentHash: string): GatewayResult | null {
    const existing = this.store.getReceiptByKey(req.idempotencyKey);
    if (!existing) return null;
    if (existing.requestHash && existing.requestHash !== contentHash) {
      this.store.audit({ event: "gateway.key_reuse", key: req.idempotencyKey });
      return { status: "blocked", reason: "This idempotency key was already used with different content." };
    }
    return { status: "completed", receipt: existing };
  }

  async requestAction(raw: unknown, now = new Date()): Promise<GatewayResult> {
    let req: ActionRequest;
    try {
      req = parseActionRequest(raw);
    } catch (err) {
      const detail = err instanceof ValidationError ? err.message : "unreadable request";
      this.store.audit({ event: "gateway.invalid", detail, at: now.toISOString() });
      return { status: "blocked", reason: `Invalid action request: ${detail}` };
    }
    this.store.audit({ event: "gateway.decide", type: req.type, key: req.idempotencyKey, at: now.toISOString() });
    const contentHash = await contentHashOf(req);
    const replay = this.receiptReuse(req, contentHash);
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
      this.store.putApproval(approval);
      return { status: "needs_approval", approval };
    }

    const frozen = await freezeActionRequest(req, docRead.bytes);
    const check = await this.runChecker(req, frozen.documentHash);
    if (!check.ok) return { status: "blocked", reason: check.reason };
    if (check.problems.length > 0) {
      // A fix verdict needs a person to review; the allow path has none.
      return { status: "blocked", reason: `Blocked by review: ${check.problems.join("; ")}` };
    }
    return this.execute(this.enrichWithDocument(req, docRead.bytes, frozen.documentHash), now);
  }

  async approveAndExecute(
    approvalId: string,
    humanId: string,
    now = new Date(),
  ): Promise<GatewayResult> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { status: "blocked", reason: "Approval not found." };
    if (new Date(approval.expiresAt).getTime() < now.getTime()) {
      // Guarded: a no-op unless the row is still pending, so this write
      // can never clobber a concurrent consume.
      this.store.expireApproval(approvalId);
      const fresh = this.store.getApproval(approvalId);
      return { status: "blocked", reason: approvalGoneReason(fresh?.status ?? "expired") };
    }
    if (approval.status !== "pending") {
      if (approval.status === "approved" && approval.approvedByHumanId === humanId) {
        return this.retryFailedApproval(approval, humanId, now);
      }
      return { status: "blocked", reason: approvalGoneReason(approval.status) };
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
      this.store.audit({ event: "gateway.stale_block", approvalId });
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
    // new execution, on the approve path as well as the allow path.
    const prior = this.store.getAttempt(stored.idempotencyKey);
    if (prior?.status === "unknown") {
      const settled = await this.reconcileUnknown(stored, now);
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
      now,
    });
    if (!consumed) {
      const fresh = this.store.getApproval(approvalId);
      if (fresh?.status === "pending") {
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      return { status: "blocked", reason: approvalGoneReason(fresh?.status ?? approval.status) };
    }
    return this.runExecution(this.enrichWithDocument(stored, docRead.bytes, frozen.documentHash), now);
  }

  // Retries an approved action whose attempt definitively failed: nothing
  // happened, so the same human approval still authorizes a clean retry
  // after every check runs again. Any other terminal state stays blocked.
  private async retryFailedApproval(approval: Approval, humanId: string, now: Date): Promise<GatewayResult> {
    if (new Date(approval.expiresAt).getTime() < now.getTime()) {
      return { status: "blocked", reason: "Approval expired." };
    }
    const attempt = this.store.getAttempt(approval.idempotencyKey);
    if (!attempt || attempt.status !== "failed") {
      return { status: "blocked", reason: approvalGoneReason(approval.status) };
    }
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
      this.store.audit({ event: "gateway.stale_block", approvalId: approval.id });
      return { status: "stale", approval, reason: "Document changed after approval." };
    }
    if (check.problems.length > 0) this.store.setApprovalProblems(approval.id, check.problems);
    if (!this.store.adoptFailedAttempt(approval.idempotencyKey, now)) {
      const receipt = this.store.getReceiptByKey(approval.idempotencyKey);
      if (receipt) return { status: "completed", receipt };
      return { status: "in_progress", reason: "Another request with this idempotency key is running." };
    }
    this.store.audit({ event: "gateway.retry_failed", key: approval.idempotencyKey });
    return this.runExecution(this.enrichWithDocument(stored, docRead.bytes, frozen.documentHash), now);
  }

  private async makeReceipt(
    req: ActionRequest,
    status: Receipt["status"],
    externalId: string,
    simulated: boolean | undefined,
    now: Date,
  ): Promise<Receipt> {
    return {
      id: crypto.randomUUID(),
      idempotencyKey: req.idempotencyKey,
      actionType: req.type,
      recipient: req.recipient,
      status,
      externalId,
      simulated: simulated ?? this.executor.simulated,
      requestHash: await contentHashOf(req),
      createdAt: now.toISOString(),
    };
  }

  // Reconciles an unknown attempt. Found settles with a receipt; confirmed
  // absent lets the caller adopt the key and execute; an unreachable
  // executor keeps the attempt unknown and blocks. A failed lookup is
  // never treated as "did not happen".
  private async reconcileUnknown(req: ActionRequest, now: Date): Promise<ReconcileOutcome> {
    let outcome: { found: true; externalId: string } | { found: false };
    try {
      outcome = await this.executor.check(req.idempotencyKey, req.personId);
    } catch (err) {
      this.store.audit({ event: "gateway.check_error", key: req.idempotencyKey, detail: String(err) });
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
      const receipt = await this.makeReceipt(req, "reconciled", outcome.externalId, undefined, now);
      this.store.putReceipt(receipt);
      this.store.updateAttempt(req.idempotencyKey, "done");
      this.store.audit({ event: "gateway.reconciled", key: req.idempotencyKey });
      return { kind: "settled", result: { status: "reconciled", receipt } };
    }
    return { kind: "absent" };
  }

  async execute(req: ActionRequest, now = new Date()): Promise<GatewayResult> {
    const contentHash = await contentHashOf(req);
    const replay = this.receiptReuse(req, contentHash);
    if (replay) return replay;
    const attempt = this.store.getAttempt(req.idempotencyKey);
    if (attempt?.requestHash && attempt.requestHash !== contentHash) {
      this.store.audit({ event: "gateway.key_reuse", key: req.idempotencyKey });
      return { status: "blocked", reason: "This idempotency key was already used with different content." };
    }
    if (attempt?.status === "in_flight") {
      return { status: "in_progress", reason: "Another request with this idempotency key is running." };
    }
    if (attempt?.status === "unknown") {
      const settled = await this.reconcileUnknown(req, now);
      if (settled.kind !== "absent") return settled.result;
      if (!this.store.adoptUnknownAttempt(req.idempotencyKey, now)) {
        const receipt = this.store.getReceiptByKey(req.idempotencyKey);
        if (receipt) return { status: "completed", receipt };
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      return this.runExecution(req, now);
    }
    if (attempt?.status === "failed") {
      // Definite failure: nothing happened, so no reconcile is needed
      // before the clean retry.
      if (!this.store.adoptFailedAttempt(req.idempotencyKey, now)) {
        const receipt = this.store.getReceiptByKey(req.idempotencyKey);
        if (receipt) return { status: "completed", receipt };
        return { status: "in_progress", reason: "Another request with this idempotency key is running." };
      }
      return this.runExecution(req, now);
    }
    if (attempt?.status === "done") {
      // Invariant: done always ships with a receipt, which the check above
      // would have returned. If it is missing anyway, reconcile once and
      // otherwise fail closed rather than executing blindly.
      const settled = await this.reconcileUnknown(req, now);
      if (settled.kind !== "absent") return settled.result;
      this.store.audit({ event: "gateway.corrupt_attempt", key: req.idempotencyKey });
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
    if (!this.store.insertAttempt(fresh)) {
      const receipt = this.store.getReceiptByKey(req.idempotencyKey);
      if (receipt) return { status: "completed", receipt };
      return { status: "in_progress", reason: "Another request with this idempotency key is running." };
    }
    return this.runExecution(req, now);
  }

  // Recovers one stranded in_flight attempt: older than the cutoff, so no
  // live request can still own it. Approve-path attempts re-verify against
  // the stored request and run without asking the person again; allow-path
  // attempts reconcile only, since no request is stored. Returns null when
  // another recovery claimed the key first.
  async recoverAttempt(key: string, now: Date, olderThanIso: string): Promise<GatewayResult | null> {
    const attempt = this.store.getAttempt(key);
    if (!attempt || attempt.status !== "in_flight" || attempt.updatedAt >= olderThanIso) return null;
    if (!this.store.claimStaleAttempt(key, olderThanIso, now)) return null;
    this.store.audit({ event: "gateway.recover_claimed", key });
    const approval = this.store.getApprovalByKey(key);
    if (!approval) return this.recoverAllowAttempt(key, attempt, now);
    let stored: ActionRequest;
    try {
      stored = parseActionRequest(JSON.parse(approval.requestJson));
    } catch {
      this.store.updateAttempt(key, "failed");
      this.store.audit({ event: "gateway.recover_corrupt", key });
      return { status: "blocked", reason: "The stored request for this key is unreadable." };
    }
    if (new Date(approval.expiresAt).getTime() < now.getTime()) {
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
      this.store.audit({ event: "gateway.stale_block", approvalId: approval.id });
      return { status: "stale", approval, reason: "Document changed after approval." };
    }
    const check = await this.runChecker(stored, frozen.documentHash);
    if (!check.ok) {
      this.store.updateAttempt(key, "failed");
      return { status: "blocked", reason: check.reason };
    }
    if (check.problems.length > 0) this.store.setApprovalProblems(approval.id, check.problems);
    const settled = await this.reconcileUnknown(stored, now);
    if (settled.kind !== "absent") return settled.result;
    return this.runExecution(this.enrichWithDocument(stored, docRead.bytes, frozen.documentHash), now);
  }

  private async recoverAllowAttempt(key: string, attempt: Attempt, now: Date): Promise<GatewayResult> {
    // No stored request exists on the allow path, so recovery reconciles
    // only: found settles with a receipt built from the attempt row,
    // absent marks the key failed so a fresh request retries cleanly.
    let outcome: { found: true; externalId: string } | { found: false };
    try {
      outcome = await this.executor.check(key, attempt.personId);
    } catch (err) {
      this.store.audit({ event: "gateway.check_error", key, detail: String(err) });
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
        simulated: this.executor.simulated,
        requestHash: attempt.requestHash,
        createdAt: now.toISOString(),
      };
      this.store.putReceipt(receipt);
      this.store.updateAttempt(key, "done");
      this.store.audit({ event: "gateway.reconciled", key });
      return { status: "reconciled", receipt };
    }
    this.store.updateAttempt(key, "failed");
    this.store.audit({ event: "gateway.recover_absent", key });
    return { status: "blocked", reason: "The outside system has no record of this key. Send the action again." };
  }

  // Runs the executor for an already-claimed (in_flight) attempt.
  private async runExecution(req: ActionRequest, now: Date): Promise<GatewayResult> {
    try {
      const out = await this.executor.execute(req);
      const receipt = await this.makeReceipt(req, "completed", out.externalId, out.simulated, now);
      this.store.putReceipt(receipt);
      this.store.updateAttempt(req.idempotencyKey, "done");
      this.store.audit({ event: "gateway.executed", key: req.idempotencyKey });
      return { status: "completed", receipt };
    } catch (err) {
      if (err instanceof TimeoutError || (err as Error)?.name === "TimeoutError") {
        const settled = await this.reconcileUnknown(req, now);
        if (settled.kind === "settled") return settled.result;
        this.store.updateAttempt(req.idempotencyKey, "unknown");
        if (settled.kind === "unavailable") return settled.result;
        this.store.audit({ event: "gateway.unknown", key: req.idempotencyKey });
        return {
          status: "blocked",
          reason: "The action timed out and its outcome is unknown. Retry with the same idempotency key; the gateway reconciles before executing again.",
        };
      }
      if (err instanceof DefiniteFailureError || (err as Error)?.name === "DefiniteFailureError") {
        const message = err instanceof Error ? err.message : String(err);
        this.store.updateAttempt(req.idempotencyKey, "failed");
        this.store.audit({ event: "gateway.executor_failed", key: req.idempotencyKey, detail: message });
        return { status: "blocked", reason: `The action failed before anything happened: ${message} Retry with the same idempotency key.` };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateAttempt(req.idempotencyKey, "unknown");
      this.store.audit({ event: "gateway.executor_error", key: req.idempotencyKey, detail: message });
      return { status: "blocked", reason: `The action failed before a receipt was recorded: ${message}` };
    }
  }
}
