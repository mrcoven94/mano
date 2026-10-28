// Stand-in engine: serves the recorded Maria spine run with no network.
// Every screen works against it today. When the engine merges, the app
// switches to EngineClient and this file keeps serving tests and demos.
//
// The stand-in is honest about hashes: approvals bind the real SHA-256 of
// the document bytes they carry, computed through the injected hasher.

import { b64encode, utf8ToBytes } from "../base64";
import {
  APPROVED_NOTICE,
  APPROVE_FOLLOWUP,
  CASEWORKER_REQUEST,
  FALLBACK_REPLY,
  GREETING,
  MAIL_REPLY,
  MARIA,
  PAYSTUB_REPLY,
  approvalNoticeText,
  approvalsReply,
  deadlinesReply,
  electricBillText,
  renewalPacketText,
  snapLetterText,
} from "./maria";
import type {
  Approval,
  ApprovalDocument,
  ApproveResult,
  ChatMessage,
  Deadline,
  DocMeta,
  EngineMode,
  Grant,
  ManoClient,
  NewAttachment,
  RevokeResult,
  Session,
} from "./types";
import { AuthError, StaleApprovalError } from "./types";

export type Hasher = (bytesB64: string) => Promise<string>;

export interface StandInOptions {
  sha256B64: Hasher;
  // Milliseconds each call waits, so loading states show in demos.
  latencyMs?: number;
  now?: () => Date;
}

interface StoredDoc {
  meta: DocMeta;
  bytesB64: string;
}

const RENEWAL_ID = "doc-renewal-packet";
const APPROVAL_ID = "appr-renewal-001";

function stamp(id: string): string {
  return `standin-${id}`;
}

export class StandInClient implements ManoClient {
  readonly mode: EngineMode = "stand-in";
  private sha256B64: Hasher;
  private latencyMs: number;
  private now: () => Date;
  private messages: ChatMessage[] = [];
  private seeded = false;
  private mailReceived = false;
  private renewalApproved: ApproveResult | null = null;
  private paystubReceived = false;
  private grants: Grant[] = [];
  private docs: StoredDoc[] = [];
  private extraDeadlines: Deadline[] = [];
  private seq = 0;

  constructor(options: StandInOptions) {
    this.sha256B64 = options.sha256B64;
    this.latencyMs = options.latencyMs ?? 350;
    this.now = options.now ?? (() => new Date());
  }

  private async wait(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${stamp(prefix)}-${this.seq}`;
  }

  private checkSession(session: Session): void {
    if (!session.token.startsWith("standin-")) throw new AuthError();
  }

  private seed(): void {
    if (this.seeded) return;
    this.seeded = true;
    this.messages = [
      {
        id: stamp("greeting"),
        role: "agent",
        text: GREETING,
        createdAt: "2026-10-28T09:00:00.000Z",
        attachments: [],
        status: "sent",
      },
    ];
    this.grants = [
      {
        recipient: "org:springfield-county",
        orgName: "Springfield County SNAP office",
        purpose: "Your SNAP renewal, case R-1042",
        caseId: "R-1042",
        scope: ["case documents", "deadlines"],
        grantedAt: "2026-10-27T15:30:00.000Z",
      },
    ];
  }

  private async renewalDoc(): Promise<StoredDoc> {
    const found = this.docs.find((d) => d.meta.id === RENEWAL_ID);
    if (found) return found;
    const bytesB64 = b64encode(utf8ToBytes(renewalPacketText()));
    const hash = await this.sha256B64(bytesB64);
    const meta: DocMeta = {
      id: RENEWAL_ID,
      name: "SNAP renewal packet.txt",
      hash,
      size: utf8ToBytes(renewalPacketText()).length,
      mimeType: "text/plain",
      createdAt: "2026-10-28T09:20:00.000Z",
    };
    const stored = { meta, bytesB64 };
    this.docs.unshift(stored);
    return stored;
  }

  private async currentApproval(): Promise<Approval> {
    const doc = await this.renewalDoc();
    return {
      id: APPROVAL_ID,
      actionType: "submit",
      recipient: "sandbox:county-portal",
      recipientName: "Springfield County SNAP office",
      purpose: "File your SNAP renewal for case R-1042",
      documentHash: doc.meta.hash,
      documentId: doc.meta.id,
      documentName: doc.meta.name,
      idempotencyKey: "spine:renewal:maria-001",
      status: this.renewalApproved ? "approved" : "pending",
      problems: [],
      createdAt: "2026-10-28T09:20:00.000Z",
      remindAt: "2026-11-03T09:00:00.000Z",
      expiresAt: "2026-11-10T09:00:00.000Z",
      escalated: false,
    };
  }

  // --- sign-in ---

  async requestCode(email: string): Promise<{ challengeId: string; maskedEmail: string }> {
    await this.wait();
    const [user, domain] = email.split("@");
    const masked = `${(user ?? "").slice(0, 1)}***@${domain ?? "email"}`;
    return { challengeId: this.nextId("challenge"), maskedEmail: masked };
  }

  async verifyCode(email: string, challengeId: string, code: string): Promise<Session> {
    await this.wait();
    if (!/^\d{6}$/.test(code)) throw new AuthError("Enter the 6-digit code.");
    if (!challengeId.startsWith("standin-")) throw new AuthError();
    void email;
    this.seed();
    return {
      token: this.nextId("token"),
      personId: MARIA.personId,
      email: MARIA.email,
      displayName: MARIA.displayName,
      expiresAt: new Date(this.now().getTime() + 24 * 3600_000).toISOString(),
    };
  }

  // --- conversation ---

  async listMessages(session: Session): Promise<ChatMessage[]> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    return [...this.messages];
  }

  async sendMessage(session: Session, text: string, attachments: NewAttachment[]): Promise<ChatMessage> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    const userMsg: ChatMessage = {
      id: this.nextId("msg"),
      role: "user",
      text,
      createdAt: this.iso(),
      attachments: attachments.map((a) => ({
        id: this.nextId("att"),
        kind: a.kind,
        name: a.name,
        mimeType: a.mimeType,
        size: Math.ceil((a.bytesB64.length * 3) / 4),
      })),
      status: "sent",
    };
    this.messages.push(userMsg);
    const reply = await this.scriptedReply(text, attachments);
    const agentMsg: ChatMessage = {
      id: this.nextId("msg"),
      role: "agent",
      text: reply.text,
      createdAt: this.iso(),
      attachments: [],
      status: "sent",
    };
    this.messages.push(agentMsg);
    for (const followUp of reply.followUps) {
      this.messages.push({
        id: this.nextId("msg"),
        role: "agent",
        text: followUp,
        createdAt: this.iso(),
        attachments: [],
        status: "sent",
      });
    }
    return agentMsg;
  }

  private async scriptedReply(
    text: string,
    attachments: NewAttachment[],
  ): Promise<{ text: string; followUps: string[] }> {
    const hasMail = attachments.some((a) => a.kind === "photo" || a.kind === "video");
    if (hasMail && !this.mailReceived) {
      this.mailReceived = true;
      await this.renewalDoc();
      this.docs.push(
        {
          meta: {
            id: "doc-snap-letter",
            name: "SNAP renewal notice (mail photo).txt",
            hash: await this.sha256B64(b64encode(utf8ToBytes(snapLetterText()))),
            size: utf8ToBytes(snapLetterText()).length,
            mimeType: "text/plain",
            createdAt: this.iso(),
          },
          bytesB64: b64encode(utf8ToBytes(snapLetterText())),
        },
        {
          meta: {
            id: "doc-electric-bill",
            name: "Electricity bill (mail photo).txt",
            hash: await this.sha256B64(b64encode(utf8ToBytes(electricBillText()))),
            size: utf8ToBytes(electricBillText()).length,
            mimeType: "text/plain",
            createdAt: this.iso(),
          },
          bytesB64: b64encode(utf8ToBytes(electricBillText())),
        },
      );
      return { text: MAIL_REPLY, followUps: [] };
    }
    if (hasMail && this.renewalApproved && !this.paystubReceived) {
      this.paystubReceived = true;
      const first = attachments[0];
      if (first) {
        this.docs.unshift({
          meta: {
            id: this.nextId("doc"),
            name: first.name,
            hash: await this.sha256B64(first.bytesB64),
            size: Math.ceil((first.bytesB64.length * 3) / 4),
            mimeType: first.mimeType,
            createdAt: this.iso(),
          },
          bytesB64: first.bytesB64,
        });
      }
      const noticeB64 = b64encode(utf8ToBytes(approvalNoticeText()));
      this.docs.unshift({
        meta: {
          id: "doc-approval-notice",
          name: "County approval notice.txt",
          hash: await this.sha256B64(noticeB64),
          size: utf8ToBytes(approvalNoticeText()).length,
          mimeType: "text/plain",
          createdAt: this.iso(),
        },
        bytesB64: noticeB64,
      });
      // The county answer lands right after in the recorded run.
      return { text: PAYSTUB_REPLY, followUps: [APPROVED_NOTICE] };
    }
    const lower = text.toLowerCase();
    if (lower.includes("deadline")) {
      const base = !this.mailReceived ? 0 : this.renewalApproved ? 1 : 2;
      const open = base + this.extraDeadlines.filter((d) => !d.done).length;
      return { text: deadlinesReply(open), followUps: [] };
    }
    if (lower.includes("approv")) {
      return { text: approvalsReply(this.mailReceived && !this.renewalApproved ? 1 : 0), followUps: [] };
    }
    if (lower.includes("hola") || lower.includes("espa")) {
      return { text: "Claro, hablamos español. Fotografíe su correo para empezar, o pregúnteme por sus fechas límite.", followUps: [] };
    }
    return { text: FALLBACK_REPLY, followUps: [] };
  }

  // --- approvals ---

  async listApprovals(session: Session): Promise<Approval[]> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    if (!this.mailReceived) return [];
    return [await this.currentApproval()];
  }

  async getApprovalDocument(session: Session, approval: Approval): Promise<ApprovalDocument> {
    await this.wait();
    this.checkSession(session);
    const doc = this.docs.find((d) => d.meta.id === approval.documentId) ?? (await this.renewalDoc());
    return { id: doc.meta.id, name: doc.meta.name, bytesB64: doc.bytesB64, hash: doc.meta.hash, mimeType: doc.meta.mimeType };
  }

  async approve(session: Session, approvalId: string, expectedHash: string | null): Promise<ApproveResult> {
    await this.wait();
    this.checkSession(session);
    const current = await this.currentApproval();
    if (approvalId !== current.id) throw new StaleApprovalError("stale");
    if (current.status !== "pending") throw new StaleApprovalError(current.status);
    if (expectedHash !== current.documentHash) throw new StaleApprovalError("stale");
    this.renewalApproved = {
      status: "completed",
      receiptId: this.nextId("receipt"),
      externalId: "sandbox-action-1042",
      simulated: true,
      reason: null,
    };
    this.messages.push(
      {
        id: this.nextId("msg"),
        role: "agent",
        text: APPROVE_FOLLOWUP,
        createdAt: this.iso(),
        attachments: [],
        status: "sent",
      },
      {
        id: this.nextId("msg"),
        role: "agent",
        text: CASEWORKER_REQUEST,
        createdAt: this.iso(),
        attachments: [],
        status: "sent",
      },
    );
    this.extraDeadlines.push({
      id: "ddl-paystub",
      title: "Send the county a pay stub",
      detail: "Springfield County asked for a pay stub from the last 30 days for case R-1042.",
      dueAt: "2026-11-12T17:00:00.000Z",
      relatedApprovalId: null,
      done: false,
    });
    return this.renewalApproved;
  }

  // --- deadlines ---

  async listDeadlines(session: Session): Promise<Deadline[]> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    if (!this.mailReceived) return [];
    const base: Deadline[] = [
      {
        id: "ddl-renewal",
        title: "SNAP renewal due",
        detail: "Springfield County, case R-1042. Your filled renewal is waiting in Approvals.",
        dueAt: "2026-11-15T17:00:00.000Z",
        relatedApprovalId: APPROVAL_ID,
        done: this.renewalApproved !== null,
      },
      {
        id: "ddl-electric",
        title: "Electricity bill, $84.20",
        detail: "Springfield Light and Power, account ending 4471.",
        dueAt: "2026-11-08T17:00:00.000Z",
        relatedApprovalId: null,
        done: false,
      },
    ];
    return [...base, ...this.extraDeadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  // --- documents ---

  async listDocuments(session: Session): Promise<DocMeta[]> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    if (this.mailReceived) await this.renewalDoc();
    return this.docs.map((d) => d.meta);
  }

  async uploadDocument(session: Session, name: string, mimeType: string, bytesB64: string): Promise<DocMeta> {
    await this.wait();
    this.checkSession(session);
    const meta: DocMeta = {
      id: this.nextId("doc"),
      name,
      hash: await this.sha256B64(bytesB64),
      size: Math.ceil((bytesB64.length * 3) / 4),
      mimeType,
      createdAt: this.iso(),
    };
    this.docs.unshift({ meta, bytesB64 });
    return meta;
  }

  async downloadDocument(session: Session, id: string): Promise<ApprovalDocument> {
    await this.wait();
    this.checkSession(session);
    const doc = this.docs.find((d) => d.meta.id === id);
    if (!doc) throw new Error("Document not found.");
    return { id: doc.meta.id, name: doc.meta.name, bytesB64: doc.bytesB64, hash: doc.meta.hash, mimeType: doc.meta.mimeType };
  }

  // --- access ---

  async listGrants(session: Session): Promise<Grant[]> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    return [...this.grants];
  }

  async revokeGrant(session: Session, recipient: string, caseId: string): Promise<RevokeResult> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    this.grants = this.grants.filter((g) => !(g.recipient === recipient && g.caseId === caseId));
    return { status: "completed", reason: null };
  }
}
