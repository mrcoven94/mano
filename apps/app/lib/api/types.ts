// The one typed client the app talks to. Every screen goes through
// ManoClient; nothing fetches the engine directly. Two implementations:
// EngineClient (apps/engine over HTTP) and StandInClient (recorded
// synthetic responses, so every screen works before the engine merges).
//
// The engine's routes live in apps/engine/src/index.ts on branch lap-500.
// Shapes the engine does not serve yet (email-code sign-in, deadlines,
// grants, conversation history) are defined here so the stand-in and the
// screens agree; EngineClient throws EngineGapError naming the missing
// route until the engine adds it.

export type EngineMode = "live" | "stand-in";

export interface Session {
  token: string;
  personId: string;
  email: string;
  displayName: string;
  expiresAt: string;
}

export type AttachmentKind = "photo" | "video" | "voice" | "file";

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  // Local file URI before upload; set on messages the person composed.
  localUri?: string;
}

export interface NewAttachment {
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  bytesB64: string;
}

export type MessageStatus = "queued" | "sent" | "failed";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
  attachments: Attachment[];
  status: MessageStatus;
}

export type ActionType = "send" | "submit" | "call" | "fax" | "share";
export type ApprovalStatus = "pending" | "approved" | "expired" | "stale" | "blocked";

// Mirrors the engine's Approval row (apps/engine/src/gateway/types.ts)
// plus the document name, so cards render without a second fetch.
export interface Approval {
  id: string;
  actionType: ActionType;
  recipient: string;
  recipientName: string;
  purpose: string;
  documentHash: string | null;
  documentId: string | null;
  documentName: string | null;
  idempotencyKey: string;
  status: ApprovalStatus;
  problems: string[];
  createdAt: string;
  remindAt: string;
  expiresAt: string;
  escalated: boolean;
}

export interface ApprovalDocument {
  id: string;
  name: string;
  bytesB64: string;
  hash: string;
  mimeType: string;
}

export interface ApproveResult {
  status: "completed" | "reconciled" | "needs_approval" | "blocked" | "stale" | "in_progress";
  receiptId: string | null;
  externalId: string | null;
  simulated: boolean;
  reason: string | null;
}

export interface Deadline {
  id: string;
  title: string;
  detail: string | null;
  dueAt: string;
  relatedApprovalId: string | null;
  done: boolean;
}

export interface DocMeta {
  id: string;
  name: string;
  hash: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

export interface Grant {
  recipient: string;
  orgName: string;
  purpose: string;
  caseId: string;
  scope: string[];
  grantedAt: string;
}

export interface RevokeResult {
  status: "completed" | "needs_approval" | "blocked";
  reason: string | null;
}

export interface ManoClient {
  readonly mode: EngineMode;
  requestCode(email: string): Promise<{ challengeId: string; maskedEmail: string }>;
  verifyCode(email: string, challengeId: string, code: string): Promise<Session>;
  listMessages(session: Session): Promise<ChatMessage[]>;
  sendMessage(session: Session, text: string, attachments: NewAttachment[]): Promise<ChatMessage>;
  listApprovals(session: Session): Promise<Approval[]>;
  getApprovalDocument(session: Session, approval: Approval): Promise<ApprovalDocument>;
  // The client re-reads the approval first and refuses when the bound
  // document hash moved; expectedHash is what the person reviewed.
  approve(session: Session, approvalId: string, expectedHash: string | null): Promise<ApproveResult>;
  listDeadlines(session: Session): Promise<Deadline[]>;
  listDocuments(session: Session): Promise<DocMeta[]>;
  uploadDocument(session: Session, name: string, mimeType: string, bytesB64: string): Promise<DocMeta>;
  downloadDocument(session: Session, id: string): Promise<ApprovalDocument>;
  listGrants(session: Session): Promise<Grant[]>;
  revokeGrant(session: Session, recipient: string, caseId: string): Promise<RevokeResult>;
}

// Thrown when a call needs an engine route that does not exist yet. The
// UI shows engineGapTitle/engineGapBody; the stand-in never throws it.
export class EngineGapError extends Error {
  readonly route: string;
  constructor(route: string) {
    super(`The engine does not serve ${route} yet.`);
    this.name = "EngineGapError";
    this.route = route;
  }
}

export class AuthError extends Error {
  constructor(message = "Sign in again.") {
    super(message);
    this.name = "AuthError";
  }
}

// The approval the person reviewed is no longer the approval on file:
// the document changed, it expired, or it was blocked. Nothing was sent.
export class StaleApprovalError extends Error {
  readonly status: ApprovalStatus;
  constructor(status: ApprovalStatus) {
    super(`This approval is ${status}; nothing was sent.`);
    this.name = "StaleApprovalError";
    this.status = status;
  }
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof AuthError || err instanceof EngineGapError || err instanceof StaleApprovalError) return false;
  return true;
}
