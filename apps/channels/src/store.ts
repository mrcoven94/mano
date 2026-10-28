// The one conversation store interface. ConversationDO backs it with its
// own SQLite; node tests use the in-memory version. All calls are sync:
// Durable Object SQLite is synchronous, and nothing here needs to wait.
import type { EventAttachment, NormalizedEvent, OutboundState } from "@mano/channels";

export interface PendingInbound {
  eventId: string;
  receivedAtMs: number;
  chatId: string;
  to: string;
  text: string | null;
  attachments: EventAttachment[];
  fromReconcile: boolean;
}

export interface OutboundRow {
  key: string;
  turn: number;
  part: number;
  tag: string;
  state: OutboundState;
  code: string | null;
  chatId: string | null;
  messageId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ApprovalRow {
  id: string;
  codeHash: string;
  summary: string;
  status: "pending" | "answered" | "expired";
  decision: "yes" | "no" | null;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ConversationMeta {
  turn: number;
  introduced: boolean;
  closed: boolean;
  optedOut: boolean;
  running: boolean;
  chatId: string | null;
  to: string | null;
  hourKey: string;
  hourCount: number;
  dayKey: string;
  dayCount: number;
  busyNoticeKey: string | null;
  lastInboundMs: number;
}

export function defaultMeta(): ConversationMeta {
  return {
    turn: 0,
    introduced: false,
    closed: false,
    optedOut: false,
    running: false,
    chatId: null,
    to: null,
    hourKey: "",
    hourCount: 0,
    dayKey: "",
    dayCount: 0,
    busyNoticeKey: null,
    lastInboundMs: 0,
  };
}

export interface ConversationStore {
  hasEvent(eventId: string): boolean;
  recordEvent(eventId: string, kind: string, atMs: number): void;
  meta(): ConversationMeta;
  saveMeta(meta: ConversationMeta): void;
  addPending(item: PendingInbound): void;
  pending(): PendingInbound[];
  clearPending(eventIds: string[]): void;
  addOutbound(row: OutboundRow): void;
  outboundByKey(key: string): OutboundRow | null;
  outboundByMessageId(messageId: string): OutboundRow | null;
  updateOutbound(key: string, patch: Partial<OutboundRow>): void;
  outbounds(): OutboundRow[];
  addApproval(row: ApprovalRow): void;
  pendingApprovals(nowMs: number): ApprovalRow[];
  answerApproval(id: string, decision: "yes" | "no"): void;
  wipe(): void;
}

export class MemoryStore implements ConversationStore {
  private events = new Map<string, { kind: string; atMs: number }>();
  private metaRow: ConversationMeta = defaultMeta();
  private pendingRows: PendingInbound[] = [];
  private outboundRows = new Map<string, OutboundRow>();
  private approvalRows = new Map<string, ApprovalRow>();

  hasEvent(eventId: string): boolean {
    return this.events.has(eventId);
  }

  recordEvent(eventId: string, kind: string, atMs: number): void {
    this.events.set(eventId, { kind, atMs });
  }

  meta(): ConversationMeta {
    return { ...this.metaRow };
  }

  saveMeta(meta: ConversationMeta): void {
    this.metaRow = { ...meta };
  }

  addPending(item: PendingInbound): void {
    this.pendingRows.push(item);
  }

  pending(): PendingInbound[] {
    return [...this.pendingRows];
  }

  clearPending(eventIds: string[]): void {
    const gone = new Set(eventIds);
    this.pendingRows = this.pendingRows.filter((p) => !gone.has(p.eventId));
  }

  addOutbound(row: OutboundRow): void {
    this.outboundRows.set(row.key, { ...row });
  }

  outboundByKey(key: string): OutboundRow | null {
    return this.outboundRows.get(key) ?? null;
  }

  outboundByMessageId(messageId: string): OutboundRow | null {
    for (const row of this.outboundRows.values()) {
      if (row.messageId === messageId) return row;
    }
    return null;
  }

  updateOutbound(key: string, patch: Partial<OutboundRow>): void {
    const row = this.outboundRows.get(key);
    if (row) this.outboundRows.set(key, { ...row, ...patch });
  }

  outbounds(): OutboundRow[] {
    return [...this.outboundRows.values()];
  }

  addApproval(row: ApprovalRow): void {
    this.approvalRows.set(row.id, { ...row });
  }

  pendingApprovals(nowMs: number): ApprovalRow[] {
    return [...this.approvalRows.values()].filter((a) => a.status === "pending" && a.expiresAtMs > nowMs);
  }

  answerApproval(id: string, decision: "yes" | "no"): void {
    const row = this.approvalRows.get(id);
    if (row) this.approvalRows.set(id, { ...row, status: "answered", decision });
  }

  wipe(): void {
    this.events.clear();
    this.metaRow = defaultMeta();
    this.pendingRows = [];
    this.outboundRows.clear();
    this.approvalRows.clear();
  }
}

export type { NormalizedEvent };
