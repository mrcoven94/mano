// Live adapter: ManoClient over HTTP. Sign-in and chat live on the web
// Worker (apps/web), which EXPO_PUBLIC_ENGINE_URL points at; the rest is
// Engine's route shape (apps/engine/src/index.ts). A route with no server
// behind it yet throws EngineGapError naming it, and the UI says so
// plainly: the web Worker answers 501 for those.

import { b64encode } from "../base64";
import { recipientName } from "../recipients";
import { provenNotSent } from "../sent-proof";
import type { Hasher } from "./standin";
import type {
  Approval,
  ApprovalDocument,
  ApproveResult,
  ChatMessage,
  Deadline,
  DeclineAnswer,
  DocMeta,
  EngineMode,
  Grant,
  ManoClient,
  NewAttachment,
  RevokeResult,
  Session,
} from "./types";
import { AuthError, EngineGapError, StaleApprovalError, UnreconciledSendError } from "./types";

export interface EngineOptions {
  baseUrl: string;
  sha256B64: Hasher;
  fetchImpl?: typeof fetch;
}

interface EngineApprovalRow {
  id: string;
  actionType: Approval["actionType"];
  recipient: string;
  purpose: string;
  documentHash: string | null;
  documentId: string | null;
  requestJson: string;
  requestHash: string;
  idempotencyKey: string;
  status: Approval["status"];
  problems: string[];
  createdAt: string;
  remindAt: string;
  expiresAt: string;
  escalated: boolean;
  outcome?: { attempt: string | null; receipt: unknown };
}

interface GatewayResultJson {
  status: ApproveResult["status"];
  approval?: unknown;
  receipt?: { id: string; externalId: string; simulated: boolean } | null;
  reason?: string;
}

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}

// A server error's words for the person, without the JSON around them.
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : body;
  } catch {
    return body;
  }
}

export class EngineClient implements ManoClient {
  readonly mode: EngineMode = "live";
  private baseUrl: string;
  private sha256B64: Hasher;
  private fetchImpl: typeof fetch;

  constructor(options: EngineOptions) {
    this.baseUrl = options.baseUrl;
    this.sha256B64 = options.sha256B64;
    // Called as a method, the browser's fetch throws "Illegal invocation".
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async call(session: Session | null, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (session) headers.set("authorization", `Bearer ${session.token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    let res: Response;
    try {
      res = await this.fetchImpl(join(this.baseUrl, path), { ...init, headers });
    } catch (err) {
      throw new Error(`Could not reach the engine: ${(err as Error).message}`, { cause: err });
    }
    if (res.status === 401 || res.status === 403) throw new AuthError();
    if (res.status === 501) throw new EngineGapError(`${init.method ?? "GET"} ${path}`);
    return res;
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(errorText(text) || `The engine answered ${res.status}.`);
    }
    return (await res.json()) as T;
  }

  async requestCode(email: string): Promise<{ challengeId: string; maskedEmail: string }> {
    const res = await this.call(null, "/api/auth/request-code", { method: "POST", body: JSON.stringify({ email }) });
    return this.json(res);
  }

  async verifyCode(email: string, challengeId: string, code: string): Promise<Session> {
    const res = await this.call(null, "/api/auth/verify-code", { method: "POST", body: JSON.stringify({ email, challengeId, code }) });
    return this.json(res);
  }

  async listMessages(session: Session): Promise<ChatMessage[]> {
    const res = await this.call(session, `/api/persons/${encodeURIComponent(session.personId)}/conversation`);
    const out = await this.json<{ messages: { id: string; role: ChatMessage["role"]; text: string; createdAt: string; ask?: ChatMessage["ask"] }[] }>(res);
    return out.messages.map((m) => ({ ...m, attachments: [], status: "sent" }));
  }

  async sendMessage(session: Session, text: string, attachments: NewAttachment[], opId?: string): Promise<ChatMessage> {
    // The engine ignores clientOpId today, so no failure here can be
    // reconciled: anything past an auth rejection holds for the
    // person's own retry instead of resending blindly. The op ID still
    // travels so a repeat dedupes once the engine honors it (PR 2).
    try {
      for (const a of attachments) {
        await this.uploadDocument(session, a.name, a.mimeType, a.bytesB64, opId);
      }
      const note = attachments.length > 0 ? `\n\n[attached: ${attachments.map((a) => a.name).join(", ")}]` : "";
      const res = await this.call(session, `/api/persons/${encodeURIComponent(session.personId)}/chat`, {
        method: "POST",
        body: JSON.stringify({ message: `${text}${note}`, clientOpId: opId ?? null }),
      });
      return await this.chatReply(res);
    } catch (err) {
      if (err instanceof AuthError || err instanceof EngineGapError) throw err;
      throw new UnreconciledSendError(opId ?? null);
    }
  }

  private async chatReply(res: Response): Promise<ChatMessage> {
    const out = await this.json<{ id?: string; reply: string; createdAt?: string; ask?: ChatMessage["ask"] }>(res);
    return {
      id: out.id ?? `live-${Date.now()}`,
      role: "agent",
      text: out.reply,
      createdAt: out.createdAt ?? new Date().toISOString(),
      attachments: [],
      status: "sent",
      ...(out.ask ? { ask: out.ask } : {}),
    };
  }

  async acknowledgeQuestion(session: Session, approvalId: string, messageId: string): Promise<void> {
    const res = await this.call(
      session,
      `/api/persons/${encodeURIComponent(session.personId)}/approvals/${encodeURIComponent(approvalId)}/shown`,
      { method: "POST", body: JSON.stringify({ messageId }) },
    );
    // 409: the question is no longer waiting, so there is nothing to retry.
    if (res.status !== 409) await this.json(res);
  }

  async listApprovals(session: Session): Promise<Approval[]> {
    const res = await this.call(session, `/api/persons/${encodeURIComponent(session.personId)}/approvals`);
    const out = await this.json<{ approvals: EngineApprovalRow[] }>(res);
    return out.approvals.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      recipient: a.recipient,
      // Never the raw ID: the protocol's name, or that it has none.
      recipientName: recipientName(a.recipient),
      purpose: a.purpose,
      documentHash: a.documentHash,
      documentId: a.documentId,
      documentName: null,
      requestJson: a.requestJson,
      requestHash: a.requestHash,
      idempotencyKey: a.idempotencyKey,
      status: a.status,
      problems: a.problems,
      createdAt: a.createdAt,
      remindAt: a.remindAt,
      expiresAt: a.expiresAt,
      escalated: a.escalated,
      // No outcome on file is not proof of no attempt.
      attempted: a.outcome ? a.outcome.attempt !== null || a.outcome.receipt !== null : true,
    }));
  }

  async getApprovalDocument(session: Session, approval: Approval): Promise<ApprovalDocument> {
    if (!approval.documentId) throw new Error("This approval carries no document.");
    const doc = await this.downloadDocument(session, approval.documentId);
    if (approval.documentHash && doc.hash !== approval.documentHash) {
      throw new StaleApprovalError("stale");
    }
    return { ...doc, hash: approval.documentHash ?? doc.hash };
  }

  async approve(
    session: Session,
    approvalId: string,
    expected: { documentHash: string | null; requestHash: string },
  ): Promise<ApproveResult> {
    const approvals = await this.listApprovals(session);
    const current = approvals.find((a) => a.id === approvalId);
    if (!current) throw new StaleApprovalError("stale");
    if (current.status !== "pending") throw new StaleApprovalError(current.status);
    // The engine binds the approval to both hashes server-side and refuses
    // anything that moved; the client checks first so the person never
    // approves a version they did not review, then sends both hashes.
    if (expected.documentHash !== current.documentHash || expected.requestHash !== current.requestHash) {
      throw new StaleApprovalError("stale");
    }
    const res = await this.call(
      session,
      `/api/persons/${encodeURIComponent(session.personId)}/approvals/${encodeURIComponent(approvalId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ expectedDocumentHash: expected.documentHash, expectedRequestHash: expected.requestHash }),
      },
    );
    const out = await this.json<GatewayResultJson>(res);
    return {
      status: out.status,
      receiptId: out.receipt?.id ?? null,
      externalId: out.receipt?.externalId ?? null,
      simulated: out.receipt?.simulated ?? false,
      reason: out.reason ?? null,
    };
  }

  async decline(session: Session, approvalId: string): Promise<DeclineAnswer> {
    const res = await this.call(
      session,
      `/api/persons/${encodeURIComponent(session.personId)}/approvals/${encodeURIComponent(approvalId)}/reject`,
      { method: "POST" },
    );
    const out = await this.json<{ status: string; reason?: string }>(res);
    // The engine ends only a pending approval and refuses anything else.
    // Its record then says what this approval became and whether any
    // approval under the same key went out.
    const all = await this.listApprovals(session);
    const current = all.find((a) => a.id === approvalId);
    const status = out.status === "rejected" ? "rejected" : current?.status;
    if (!current || !status || status === "pending") throw new Error(out.reason ?? "The engine did not decline this approval.");
    return { status, notSent: provenNotSent(all.filter((a) => a.idempotencyKey === current.idempotencyKey)) };
  }

  async listDeadlines(_session: Session): Promise<Deadline[]> {
    throw new EngineGapError("GET /api/persons/:id/deadlines");
  }

  async listDocuments(_session: Session): Promise<DocMeta[]> {
    throw new EngineGapError("GET /api/persons/:id/documents");
  }

  async uploadDocument(session: Session, name: string, mimeType: string, bytesB64: string, opId?: string): Promise<DocMeta> {
    void mimeType;
    const res = await this.call(session, `/api/persons/${encodeURIComponent(session.personId)}/documents`, {
      method: "POST",
      body: JSON.stringify({ name, contentB64: bytesB64, clientOpId: opId ?? null }),
    });
    const out = await this.json<{ id: string; hash: string }>(res);
    return {
      id: out.id,
      name,
      hash: out.hash,
      size: Math.ceil((bytesB64.length * 3) / 4),
      mimeType,
      createdAt: new Date().toISOString(),
    };
  }

  async downloadDocument(session: Session, id: string): Promise<ApprovalDocument> {
    const res = await this.call(session, `/api/persons/${encodeURIComponent(session.personId)}/documents/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `The engine answered ${res.status}.`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const bytesB64 = b64encode(bytes);
    return {
      id,
      name: filenameFromDisposition(res.headers.get("content-disposition")) ?? "document",
      bytesB64,
      hash: await this.sha256B64(bytesB64),
      mimeType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async listGrants(_session: Session): Promise<Grant[]> {
    throw new EngineGapError("GET /api/persons/:id/consents");
  }

  async checkLink(session: Session, url: string): Promise<{ allowed: boolean; reason: string | null }> {
    const res = await this.call(session, "/api/check-link", { method: "POST", body: JSON.stringify({ url }) });
    const out = await this.json<{ allowed: boolean; reason?: string }>(res);
    return { allowed: out.allowed === true, reason: out.reason ?? null };
  }

  async revokeGrant(session: Session, recipient: string, caseId: string): Promise<RevokeResult> {
    const idempotencyKey = `consent-revoke:${session.personId}:${recipient}:${caseId}`;
    // Reconcile before acting: the deterministic key names the person,
    // the organization and the grant, so a row already on file answers
    // without a second POST.
    const existing = (await this.listApprovals(session)).find((a) => a.idempotencyKey === idempotencyKey);
    if (existing?.status === "approved") return { status: "completed", reason: null };
    if (existing?.status === "pending") return { status: "needs_approval", reason: null };
    const res = await this.call(session, `/api/persons/${encodeURIComponent(session.personId)}/action`, {
      method: "POST",
      body: JSON.stringify({
        type: "share",
        recipient,
        purpose: "revoke access",
        payload: { consent: "revoke", caseId },
        idempotencyKey,
        actor: "foreground",
      }),
    });
    const out = await this.json<GatewayResultJson>(res);
    if (out.status === "completed" || out.status === "reconciled") return { status: "completed", reason: null };
    if (out.status === "needs_approval" || out.status === "in_progress") {
      return { status: "needs_approval", reason: out.reason ?? null };
    }
    return { status: "blocked", reason: out.reason ?? null };
  }
}
