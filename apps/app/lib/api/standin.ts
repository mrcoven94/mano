// Stand-in engine: serves the recorded Maria spine run with no network.
// Every screen works against it today. When the engine merges, the app
// switches to EngineClient and this file keeps serving tests and demos.
//
// The stand-in is honest about hashes: approvals bind the real SHA-256 of
// the document bytes they carry, computed through the injected hasher.

import { b64encode, utf8ToBytes } from "../base64";
import { provenNotSent } from "../sent-proof";
import type { Language } from "../strings";
import {
  DEMO_WORDS,
  MARIA,
  RENEWAL_ANSWERS,
  RENEWAL_DECLARATION,
  approvalNoticePdfB64,
  electricBillText,
  renewalPacketText,
  snapLetterText,
} from "./maria";
import type {
  Approval,
  ApprovalDocument,
  DeclineAnswer,
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
  // The language it answers in. What it says is written when it says it, as
  // in a real thread. The frozen approval and its document stay in English,
  // as a live one does, so a language change never makes an approval stale.
  language?: () => Language;
}

interface StoredDoc {
  meta: DocMeta;
  bytesB64: string;
}

const RENEWAL_ID = "doc-renewal-packet";
const APPROVAL_ID = "appr-renewal-001";
const SIX_DIGITS = /^\d{6}$/;
const HTTPS_LINK = /^https:\/\/[^/\s]+/i;

function stamp(id: string): string {
  return `standin-${id}`;
}

export class StandInClient implements ManoClient {
  readonly mode: EngineMode = "stand-in";
  private sha256B64: Hasher;
  private latencyMs: number;
  private now: () => Date;
  private language: () => Language;
  private messages: ChatMessage[] = [];
  private seeded = false;
  private mailReceived = false;
  private renewalApproved: ApproveResult | null = null;
  private renewalDeclined = false;
  private paystubReceived = false;
  private grants: Grant[] = [];
  private docs: StoredDoc[] = [];
  private extraDeadlines: Deadline[] = [];
  private completedOps = new Map<string, ChatMessage>();
  private seq = 0;

  constructor(options: StandInOptions) {
    this.sha256B64 = options.sha256B64;
    this.latencyMs = options.latencyMs ?? 350;
    this.now = options.now ?? (() => new Date());
    this.language = options.language ?? (() => "en");
  }

  private get words() {
    return DEMO_WORDS[this.language()];
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
        text: this.words.greeting,
        createdAt: "2026-10-28T09:00:00.000Z",
        attachments: [],
        status: "sent",
      },
    ];
    this.grants = [
      {
        recipient: "org:springfield-county",
        orgName: "Springfield County SNAP office",
        purpose: this.words.grantPurpose,
        caseId: "R-1042",
        scope: this.words.grantScope,
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

  // The one decision read. A YES or NO checks it after its last await
  // and writes in the same synchronous step, so of two racing decisions
  // exactly one finds the renewal pending.
  private renewalStatus(): DeclineAnswer["status"] | "pending" {
    if (this.renewalApproved) return "approved";
    if (this.renewalDeclined) return "rejected";
    return "pending";
  }

  private async currentApproval(): Promise<Approval> {
    const doc = await this.renewalDoc();
    const requestJson = JSON.stringify({
      type: "submit",
      recipient: "sandbox:county-portal",
      purpose: "File your SNAP renewal for case R-1042",
      documentId: doc.meta.id,
      payload: { ...RENEWAL_ANSWERS, declaration: RENEWAL_DECLARATION, attachment: "SNAP renewal packet" },
      idempotencyKey: "spine:renewal:maria-001",
      actor: "foreground",
      personId: MARIA.personId,
    });
    const requestHash = await this.sha256B64(b64encode(utf8ToBytes(requestJson)));
    return {
      id: APPROVAL_ID,
      actionType: "submit",
      recipient: "sandbox:county-portal",
      recipientName: "Springfield County SNAP office",
      purpose: "File your SNAP renewal for case R-1042",
      documentHash: doc.meta.hash,
      documentId: doc.meta.id,
      documentName: doc.meta.name,
      requestJson,
      requestHash,
      idempotencyKey: "spine:renewal:maria-001",
      status: this.renewalStatus(),
      problems: [],
      createdAt: "2026-10-28T09:20:00.000Z",
      remindAt: "2026-11-03T09:00:00.000Z",
      expiresAt: "2026-11-10T09:00:00.000Z",
      escalated: false,
      attempted: this.renewalApproved !== null,
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
    if (!SIX_DIGITS.test(code)) throw new AuthError("Enter the 6-digit code.");
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

  async acknowledgeQuestion(session: Session): Promise<void> {
    this.checkSession(session);
  }

  async sendMessage(session: Session, text: string, attachments: NewAttachment[], opId?: string): Promise<ChatMessage> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    // A retried operation returns its recorded reply instead of running
    // the script again: reconcile before doing new work.
    const recorded = opId ? this.completedOps.get(opId) : undefined;
    if (recorded) return recorded;
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
      ...(reply.ask ? { ask: { approvalId: reply.ask } } : {}),
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
    if (opId) this.completedOps.set(opId, agentMsg);
    return agentMsg;
  }

  private async scriptedReply(
    text: string,
    attachments: NewAttachment[],
  ): Promise<{ text: string; followUps: string[]; ask?: string }> {
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
      return { text: this.words.mailReply, followUps: [], ask: APPROVAL_ID };
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
      const noticeB64 = approvalNoticePdfB64();
      this.docs.unshift({
        meta: {
          id: "doc-approval-notice",
          name: "County approval notice.pdf",
          hash: await this.sha256B64(noticeB64),
          size: Math.ceil((noticeB64.length * 3) / 4),
          mimeType: "application/pdf",
          createdAt: this.iso(),
        },
        bytesB64: noticeB64,
      });
      this.extraDeadlines = this.extraDeadlines.map((d) =>
        d.id === "ddl-paystub" ? { id: d.id, dueAt: d.dueAt, relatedApprovalId: null, done: true, ...this.words.paystubDeadlineDone } : d,
      );
      // The county answer lands right after in the recorded run.
      return { text: this.words.paystubReply, followUps: [this.words.approvedNotice] };
    }
    const lower = text.toLowerCase();
    // "Ask Mano to change something" opens the chat with these words.
    // Only while the renewal waits: once decided, "nothing was sent" may be false.
    const waiting = this.mailReceived && this.renewalStatus() === "pending";
    if (waiting && lower.includes("please change")) return { text: DEMO_WORDS.en.changeReply, followUps: [], ask: APPROVAL_ID };
    if (waiting && lower.includes("por favor cambie")) return { text: DEMO_WORDS.es.changeReply, followUps: [], ask: APPROVAL_ID };
    if (lower.includes("deadline") || lower.includes("fecha")) {
      const base = !this.mailReceived ? 0 : this.renewalApproved ? 1 : 2;
      const open = base + this.extraDeadlines.filter((d) => !d.done).length;
      return { text: this.words.deadlinesReply(open), followUps: [] };
    }
    if (lower.includes("approv") || lower.includes("aprob")) {
      const pending = this.mailReceived && this.renewalStatus() === "pending";
      return { text: this.words.approvalsReply(pending ? 1 : 0), followUps: [], ...(pending ? { ask: APPROVAL_ID } : {}) };
    }
    if (lower.includes("hola") || lower.includes("espa")) {
      return { text: "Claro, hablamos español. Fotografíe su correo para empezar, o pregúnteme por sus fechas límite.", followUps: [] };
    }
    return { text: this.words.fallbackReply, followUps: [] };
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

  async approve(
    session: Session,
    approvalId: string,
    expected: { documentHash: string | null; requestHash: string },
  ): Promise<ApproveResult> {
    await this.wait();
    this.checkSession(session);
    const current = await this.currentApproval();
    if (approvalId !== current.id) throw new StaleApprovalError("stale");
    const status = this.renewalStatus();
    if (status !== "pending") throw new StaleApprovalError(status);
    if (expected.documentHash !== current.documentHash || expected.requestHash !== current.requestHash) {
      throw new StaleApprovalError("stale");
    }
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
        text: this.words.approveFollowup,
        createdAt: this.iso(),
        attachments: [],
        status: "sent",
      },
      {
        id: this.nextId("msg"),
        role: "agent",
        text: this.words.caseworkerRequest,
        createdAt: this.iso(),
        attachments: [],
        status: "sent",
      },
    );
    this.extraDeadlines.push({
      id: "ddl-paystub",
      ...this.words.paystubDeadline,
      dueAt: "2026-11-12T17:00:00.000Z",
      relatedApprovalId: null,
      done: false,
      photoOf: "pay-stub",
    });
    return this.renewalApproved;
  }

  // A NO ends only a pending renewal and says so in chat once; a repeat,
  // or a NO after a YES, answers with the status already on file.
  async decline(session: Session, approvalId: string): Promise<DeclineAnswer> {
    await this.wait();
    this.checkSession(session);
    const current = await this.currentApproval();
    if (approvalId !== current.id) throw new Error("Approval not found.");
    const status = this.renewalStatus();
    if (status !== "pending") return this.answerNo(current, status);
    this.renewalDeclined = true;
    this.messages.push({
      id: this.nextId("msg"),
      role: "agent",
      text: this.words.declineReply,
      createdAt: this.iso(),
      attachments: [],
      status: "sent",
    });
    return this.answerNo(current, "rejected");
  }

  // Judged from the live decision, not the snapshot read before it.
  private answerNo(current: Approval, status: DeclineAnswer["status"]): DeclineAnswer {
    return { status, notSent: provenNotSent([{ ...current, status, attempted: this.renewalApproved !== null }]) };
  }

  // --- deadlines ---

  // The renewal's line follows the decision, so a card never says it waits
  // once it does not.
  private renewalWords(): { title: string; detail: string } {
    const status = this.renewalStatus();
    if (status === "approved") return this.words.renewalDeadlineApproved;
    if (status === "rejected") return this.words.renewalDeadlineDeclined;
    return this.words.renewalDeadline;
  }

  async listDeadlines(session: Session): Promise<Deadline[]> {
    await this.wait();
    this.checkSession(session);
    this.seed();
    if (!this.mailReceived) return [];
    const base: Deadline[] = [
      {
        id: "ddl-renewal",
        ...this.renewalWords(),
        dueAt: "2026-11-15T17:00:00.000Z",
        relatedApprovalId: APPROVAL_ID,
        done: this.renewalApproved !== null,
      },
      {
        id: "ddl-electric",
        ...this.words.electricDeadline,
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

  async checkLink(session: Session, url: string): Promise<{ allowed: boolean; reason: string | null }> {
    await this.wait();
    this.checkSession(session);
    // Recorded verdicts: encrypted pages load, everything else stays shut.
    if (HTTPS_LINK.test(url)) return { allowed: true, reason: null };
    return { allowed: false, reason: "Blocked in the demo." };
  }
}
