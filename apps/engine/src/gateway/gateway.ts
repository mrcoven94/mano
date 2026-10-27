import { canonicalJson } from "@mano/protocol";
import { sha256Hex, bytesToBase64 } from "../hash.js";
import { checkLinkSafety } from "../link-safety.js";
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
import { TimeoutError } from "./types.js";
import { ValidationError, parseActionRequest } from "./validate.js";
import { LocalRulesChecker, checkerWithTimeout, type Checker, type CheckResult } from "./checker.js";

export interface ApprovalStore {
  getApproval(id: string): Approval | null;
  putApproval(a: Approval): void;
  // Atomically moves a pending approval to approved and records the
  // execution attempt. Returns null when the approval is not pending or
  // the key is already claimed. Implementations must perform both writes
  // with no await between them.
  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt): Approval | null;
  getReceiptByKey(key: string): Receipt | null;
  putReceipt(r: Receipt): void;
  getAttempt(key: string): Attempt | null;
  insertAttempt(a: Attempt): boolean;
  updateAttempt(key: string, status: Attempt["status"]): void;
  audit(entry: Record<string, unknown>): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  approvals = new Map<string, Approval>();
  receipts = new Map<string, Receipt>();
  attempts = new Map<string, Attempt>();
  auditLog: Record<string, unknown>[] = [];
  getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }
  putApproval(a: Approval) {
    this.approvals.set(a.id, a);
  }
  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt): Approval | null {
    const current = this.approvals.get(id);
    if (!current || current.status !== "pending") return null;
    if (this.attempts.has(attempt.key)) return null;
    current.status = "approved";
    current.approvedByHumanId = humanId;
    this.approvals.set(id, current);
    this.attempts.set(attempt.key, attempt);
    return current;
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

// URLs the action would touch: a URL recipient plus URL-valued payload
// fields. The gateway checks these before acting.
export function collectActionUrls(req: ActionRequest): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) urls.push(value);
  };
  push(req.recipient);
  push(req.payload.url);
  push(req.payload.link);
  push(req.payload.href);
  return [...new Set(urls)];
}

function bytesToB64(input: Uint8Array | string): string {
  return typeof input === "string"
    ? bytesToBase64(new TextEncoder().encode(input))
    : bytesToBase64(input);
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
  const documentB64 = documentBytes == null ? null : bytesToB64(documentBytes);
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
    documentHash: documentB64 == null ? null : await sha256Hex(documentB64),
  };
}

function fingerprintToJson(fingerprint: Record<string, unknown>): string {
  return canonicalJson(fingerprint);
}

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
    const bytes = await this.documents.getBytes(documentId);
    if (bytes == null) {
      return {
        ok: false,
        result: { status: "blocked", reason: `Document ${documentId} was not found on the server.` },
      };
    }
    return { ok: true, bytes };
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
    const existing = this.store.getReceiptByKey(req.idempotencyKey);
    if (existing) return { status: "completed", receipt: existing };

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
    return this.execute(req, now);
  }

  async approveAndExecute(
    approvalId: string,
    humanId: string,
    now = new Date(),
  ): Promise<GatewayResult> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { status: "blocked", reason: "Approval not found." };
    if (new Date(approval.expiresAt).getTime() < now.getTime()) {
      approval.status = "expired";
      this.store.putApproval(approval);
      return { status: "blocked", reason: "Approval expired." };
    }
    if (approval.status !== "pending") {
      const reasons: Record<string, string> = {
        approved: "This approval was already used.",
        stale: "This approval is stale: the request changed after it was created.",
        blocked: "This approval is blocked.",
        expired: "Approval expired.",
      };
      return { status: "blocked", reason: reasons[approval.status] ?? "This approval is no longer pending." };
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
      approval.status = "blocked";
      this.store.putApproval(approval);
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
      approval.status = "stale";
      this.store.putApproval(approval);
      this.store.audit({ event: "gateway.stale_block", approvalId });
      return { status: "stale", approval, reason: "Document changed after approval." };
    }
    if (check.problems.length > 0) {
      approval.problems = check.problems;
      this.store.putApproval(approval);
    }
    const attempt: Attempt = {
      key: stored.idempotencyKey,
      status: "in_flight",
      updatedAt: now.toISOString(),
    };
    const consumed = this.store.consumeApprovalAndClaim(approvalId, humanId, attempt);
    if (!consumed) {
      return { status: "blocked", reason: "This approval was already used or is in progress." };
    }
    return this.execute(stored, now);
  }

  async execute(req: ActionRequest, now = new Date()): Promise<GatewayResult> {
    const existing = this.store.getReceiptByKey(req.idempotencyKey);
    if (existing) return { status: "completed", receipt: existing };
    try {
      const out = await this.executor.execute(req);
      const receipt: Receipt = {
        id: crypto.randomUUID(),
        idempotencyKey: req.idempotencyKey,
        actionType: req.type,
        recipient: req.recipient,
        status: "completed",
        externalId: out.externalId,
        createdAt: now.toISOString(),
      };
      this.store.putReceipt(receipt);
      this.store.audit({ event: "gateway.executed", key: req.idempotencyKey });
      return { status: receipt.status, receipt };
    } catch (err) {
      if (err instanceof TimeoutError || (err as Error)?.name === "TimeoutError") {
        const found = await this.executor.check(req.idempotencyKey);
        if (found) {
          const receipt: Receipt = {
            id: crypto.randomUUID(),
            idempotencyKey: req.idempotencyKey,
            actionType: req.type,
            recipient: req.recipient,
            status: "reconciled",
            externalId: found.externalId,
            createdAt: now.toISOString(),
          };
          this.store.putReceipt(receipt);
          return { status: "reconciled", receipt };
        }
        return { status: "blocked", reason: "Timed out and no receipt found. Safe to retry with the same idempotency key." };
      }
      throw err;
    }
  }
}

export class InMemoryExecutor implements Executor {
  calls: ActionRequest[] = [];
  completed = new Map<string, { externalId: string }>();
  failNextWithTimeout = false;

  async execute(req: ActionRequest): Promise<{ externalId: string }> {
    if (this.completed.has(req.idempotencyKey)) {
      return this.completed.get(req.idempotencyKey)!;
    }
    this.calls.push(req);
    const externalId = `sim-${this.calls.length}`;
    this.completed.set(req.idempotencyKey, { externalId });
    if (this.failNextWithTimeout) {
      this.failNextWithTimeout = false;
      throw new TimeoutError();
    }
    return { externalId };
  }

  async check(idempotencyKey: string) {
    return this.completed.get(idempotencyKey) ?? null;
  }
}
