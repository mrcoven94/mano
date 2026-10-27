import type { SourceCitation } from "@mano/protocol";

export type ActionType = "send" | "submit" | "call" | "fax" | "share";
export type PolicyDecision = "allow" | "ask" | "block";
export type ActorKind = "foreground" | "background";

export interface ActionRequest {
  type: ActionType;
  recipient: string;
  purpose: string;
  documentId?: string;
  documentContent?: string;
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
  createdAt: string;
}

export interface GatewayResult {
  status: "completed" | "needs_approval" | "blocked" | "stale" | "reconciled";
  approval?: Approval;
  receipt?: Receipt;
  reason?: string;
}

export interface Executor {
  execute(req: ActionRequest): Promise<{ externalId: string }>;
  check(idempotencyKey: string): Promise<{ externalId: string } | null>;
}

export class TimeoutError extends Error {
  constructor(msg = "executor timed out") {
    super(msg);
    this.name = "TimeoutError";
  }
}
