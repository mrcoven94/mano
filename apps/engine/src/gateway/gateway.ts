import { sha256Hex } from "../hash.js";
import { approvalWindow, evaluatePolicy } from "./policy.js";
import type {
  ActionRequest,
  Approval,
  Executor,
  GatewayResult,
  PolicyDecision,
  Receipt,
} from "./types.js";
import { TimeoutError } from "./types.js";

export interface ApprovalStore {
  getApproval(id: string): Approval | null;
  putApproval(a: Approval): void;
  getReceiptByKey(key: string): Receipt | null;
  putReceipt(r: Receipt): void;
  audit(entry: Record<string, unknown>): void;
}

export class MemoryApprovalStore implements ApprovalStore {
  approvals = new Map<string, Approval>();
  receipts = new Map<string, Receipt>();
  auditLog: Record<string, unknown>[] = [];
  getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }
  putApproval(a: Approval) {
    this.approvals.set(a.id, a);
  }
  getReceiptByKey(key: string) {
    return this.receipts.get(key) ?? null;
  }
  putReceipt(r: Receipt) {
    this.receipts.set(r.idempotencyKey, r);
  }
  audit(entry: Record<string, unknown>) {
    this.auditLog.push(entry);
  }
}

export class ActionGateway {
  constructor(
    private store: ApprovalStore,
    private executor: Executor,
    private policyOverrides: Partial<Record<string, PolicyDecision>> = {},
  ) {}

  async requestAction(req: ActionRequest, now = new Date()): Promise<GatewayResult> {
    this.store.audit({ event: "gateway.decide", type: req.type, key: req.idempotencyKey, at: now.toISOString() });
    const existing = this.store.getReceiptByKey(req.idempotencyKey);
    if (existing) return { status: "completed", receipt: existing };

    const decision = evaluatePolicy(req, this.policyOverrides as never);
    if (decision === "block") {
      this.store.audit({ event: "gateway.block", type: req.type, reason: "policy" });
      return { status: "blocked", reason: "Policy blocks this action." };
    }
    if (decision === "ask") {
      const docHash = req.documentContent != null ? await sha256Hex(req.documentContent) : null;
      const win = approvalWindow(now, req.deadlineAt);
      const approval: Approval = {
        id: crypto.randomUUID(),
        actionType: req.type,
        recipient: req.recipient,
        purpose: req.purpose,
        documentHash: docHash,
        documentId: req.documentId ?? null,
        idempotencyKey: req.idempotencyKey,
        status: "pending",
        approvedByHumanId: null,
        createdAt: win.createdAt.toISOString(),
        remindAt: win.remindAt.toISOString(),
        expiresAt: win.expiresAt.toISOString(),
        escalated: win.escalated,
      };
      this.store.putApproval(approval);
      return { status: "needs_approval", approval };
    }
    return this.execute(req, now);
  }

  async approveAndExecute(
    approvalId: string,
    humanId: string,
    currentDocumentContent: string | undefined,
    req: ActionRequest,
    now = new Date(),
  ): Promise<GatewayResult> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) return { status: "blocked", reason: "Approval not found." };
    if (new Date(approval.expiresAt).getTime() < now.getTime()) {
      approval.status = "expired";
      this.store.putApproval(approval);
      return { status: "blocked", reason: "Approval expired." };
    }
    if (approval.documentHash != null) {
      const currentHash =
        currentDocumentContent != null ? await sha256Hex(currentDocumentContent) : null;
      if (currentHash !== approval.documentHash) {
        approval.status = "stale";
        this.store.putApproval(approval);
        this.store.audit({ event: "gateway.stale_block", approvalId });
        return { status: "stale", approval, reason: "Document changed after approval." };
      }
    }
    if (approval.recipient !== req.recipient || approval.purpose !== req.purpose) {
      approval.status = "stale";
      this.store.putApproval(approval);
      return { status: "stale", approval, reason: "Recipient or purpose changed." };
    }
    approval.status = "approved";
    approval.approvedByHumanId = humanId;
    this.store.putApproval(approval);
    return this.execute(req, now, true);
  }

  async execute(req: ActionRequest, now = new Date(), reconciled = false): Promise<GatewayResult> {
    const existing = this.store.getReceiptByKey(req.idempotencyKey);
    if (existing) return { status: reconciled ? "reconciled" : "completed", receipt: existing };
    try {
      const out = await this.executor.execute(req);
      const receipt: Receipt = {
        id: crypto.randomUUID(),
        idempotencyKey: req.idempotencyKey,
        actionType: req.type,
        recipient: req.recipient,
        status: reconciled ? "reconciled" : "completed",
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
    const externalId = `ext-${this.calls.length}`;
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
