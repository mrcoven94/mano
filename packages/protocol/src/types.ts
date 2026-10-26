export type MessageType =
  | "case.open"
  | "document.request"
  | "document.provide"
  | "decision"
  | "notice"
  | "consent.grant"
  | "consent.revoke";

export interface SourceCitation {
  kind: "document" | "message" | "profile" | "program";
  id: string;
  quote?: string;
}

export interface ProtocolMessage<T = unknown> {
  id: string;
  type: MessageType;
  caseId: string;
  fromAgentId: string;
  toAgentId: string;
  payload: T;
  sources: SourceCitation[];
  approvedByHumanId: string | null;
  idempotencyKey: string;
  createdAt: string;
  signature: string;
  signerPublicKey: string;
}

export interface CaseOpenPayload {
  personId: string;
  programId: string;
  purpose: string;
  synthetic: boolean;
}

export interface DocumentRequestPayload {
  documentKind: string;
  reason: string;
  dueAt?: string;
}

export interface DocumentProvidePayload {
  documentId: string;
  documentHash: string;
  r2Key: string;
}

export interface DecisionPayload {
  outcome: "approved" | "denied" | "needs_info";
  reason: string;
  decidedByHumanId: string;
}

export interface NoticePayload {
  text: string;
  channel: "web" | "sms" | "email" | "fax";
}

export interface ConsentGrantPayload {
  orgAgentId: string;
  purpose: string;
  scope: string[];
  expiresAt?: string;
}

export interface ConsentRevokePayload {
  orgAgentId: string;
  note?: string;
}
