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
  // The bubble text, so an uncertain send can replay the exact same body
  // under its key later. Stored, never logged.
  text: string;
  state: OutboundState;
  code: string | null;
  chatId: string | null;
  messageId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

// A delivery receipt that arrived before its send response. Held by
// message ID and applied when the send lands, so an early receipt is
// never lost.
export interface HeldReceipt {
  messageId: string;
  chatId: string | null;
  state: OutboundState;
  code: string | null;
  eventId: string;
  atMs: number;
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

export interface AnswerBubble {
  part: number;
  tag: string;
  text: string;
}

// A turn persisted before any external call. Pending input is cleared
// only when the turn reaches a final state, so an interrupted turn (crash
// between calls) resumes from this row on the next alarm instead of
// losing the person's message or doubling the reply.
export interface PersistedTurn {
  turn: number;
  itemsJson: string;
  chatId: string | null;
  to: string | null;
  answerJson: string | null;
  costUsd: number | null;
  costSettled: boolean;
  state: "started" | "finished";
  createdAtMs: number;
  updatedAtMs: number;
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
  byteDayKey: string;
  byteDayCount: number;
  // Bumped on every delete. Idempotency keys carry the generation, and
  // work started under an older one stops instead of writing.
  generation: number;
  // When the conversation was last deleted, 0 when never. Events older
  // than the cutoff are dropped, so queued redeliveries and feed replays
  // cannot recreate wiped data.
  deletedAtMs: number;
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
    byteDayKey: "",
    byteDayCount: 0,
    generation: 0,
    deletedAtMs: 0,
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
  holdReceipt(receipt: HeldReceipt): void;
  takeReceipts(messageId: string): HeldReceipt[];
  addApproval(row: ApprovalRow): void;
  pendingApprovals(nowMs: number): ApprovalRow[];
  answerApproval(id: string, decision: "yes" | "no"): void;
  startTurn(row: PersistedTurn): void;
  unfinishedTurn(): PersistedTurn | null;
  updateTurnAnswer(turn: number, answerJson: string, costUsd: number, atMs: number): void;
  markTurnSettled(turn: number, atMs: number): void;
  finishTurn(turn: number, atMs: number): void;
  wipe(deletedAtMs: number): void;
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

  private heldReceipts: HeldReceipt[] = [];

  holdReceipt(receipt: HeldReceipt): void {
    if (!this.heldReceipts.some((r) => r.eventId === receipt.eventId)) {
      this.heldReceipts.push({ ...receipt });
    }
  }

  takeReceipts(messageId: string): HeldReceipt[] {
    const taken = this.heldReceipts.filter((r) => r.messageId === messageId);
    if (taken.length > 0) {
      this.heldReceipts = this.heldReceipts.filter((r) => r.messageId !== messageId);
    }
    return taken;
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

  private turnRows = new Map<number, PersistedTurn>();

  startTurn(row: PersistedTurn): void {
    this.turnRows.set(row.turn, { ...row });
  }

  unfinishedTurn(): PersistedTurn | null {
    let oldest: PersistedTurn | null = null;
    for (const row of this.turnRows.values()) {
      if (row.state !== "started") continue;
      if (!oldest || row.turn < oldest.turn) oldest = row;
    }
    return oldest ? { ...oldest } : null;
  }

  updateTurnAnswer(turn: number, answerJson: string, costUsd: number, atMs: number): void {
    const row = this.turnRows.get(turn);
    if (row) this.turnRows.set(turn, { ...row, answerJson, costUsd, updatedAtMs: atMs });
  }

  markTurnSettled(turn: number, atMs: number): void {
    const row = this.turnRows.get(turn);
    if (row) this.turnRows.set(turn, { ...row, costSettled: true, updatedAtMs: atMs });
  }

  finishTurn(turn: number, atMs: number): void {
    const row = this.turnRows.get(turn);
    if (row) this.turnRows.set(turn, { ...row, state: "finished", updatedAtMs: atMs });
  }

  wipe(deletedAtMs: number): void {
    const generation = this.metaRow.generation + 1;
    const turn = this.metaRow.turn;
    this.events.clear();
    this.metaRow = { ...defaultMeta(), generation, turn, deletedAtMs };
    this.pendingRows = [];
    this.outboundRows.clear();
    this.heldReceipts = [];
    this.approvalRows.clear();
    this.turnRows.clear();
  }
}

export type { NormalizedEvent };
