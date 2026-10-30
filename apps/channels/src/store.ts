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
  // The provider's id for the inbound message, for tapbacks and inline
  // replies. Null on continuation pieces and older rows.
  messageId?: string | null;
  // The crisis decision for the whole message this piece came from, made
  // when the message arrives, before it is split, and stored with every
  // piece: true, false, or "ask" (one short health question, decided once
  // by the model check before its turn and then stored as true or false).
  // Every chunk, retry, restart and replay reads it; nothing is ever
  // recomputed per piece. Missing means crisis, always (Sol's sixth
  // review: rows from before the decision was stored).
  crisis?: boolean | "ask";
}

export interface OutboundRow {
  key: string;
  turn: number;
  part: number;
  tag: string;
  // The bubble text, so an uncertain send can replay the exact same body
  // under its key later. Stored, never logged.
  text: string;
  // Failed attempts to resolve this send. Drives retry backoff.
  attempts: number;
  state: OutboundState;
  code: string | null;
  chatId: string | null;
  messageId: string | null;
  // The inbound message this bubble answers inline. Part of the payload
  // bound to the idempotency key, so a replay sends it unchanged.
  replyTo?: string | null;
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
  // "" for a text bubble, "react" for a tapback, whose text is the
  // tapback and messageId the message it goes on.
  tag: string;
  text: string;
  messageId?: string | null;
  replyTo?: string | null;
  // From replies before every reply had words; never set now.
  fallback?: string | null;
  // For a reaction: the decoration epoch it was planned under.
  epoch?: number;
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
  // Infrastructure failures while running this turn. Drives retry
  // backoff; the turn retries until it reaches a final outcome.
  attempts: number;
  state: "started" | "finished";
  createdAtMs: number;
  updatedAtMs: number;
}

// An agent-started delivery (reminder, nudge) keyed by the agent's own
// idempotency key. Recorded before the first send, so a redelivery
// resumes the same turn instead of doubling the text.
export interface AgentSendRow {
  key: string;
  turn: number;
  // The deletion generation the delivery belongs to, fixed when it was
  // first accepted. A retry never adopts a newer generation.
  generation: number;
  // refused and failed are final: the provider declined a bubble for good.
  state: "sending" | "sent" | "refused" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
}

// An approval question a turn's answer carried, kept until the agent has
// been told it reached the person (or that it did not).
export interface PresentationRow {
  turn: number;
  approvalId: string;
  approval: string;
  generation: number;
  state: "pending" | "reported" | "not_shown";
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
  // The pending turn's hold anchor: when the person first started typing
  // for it, 0 when there is none. The hold never runs past this plus
  // TYPING_HOLD_CAP_MS, however often typing stops and starts.
  typingSinceMs: number;
  // Whether the person is typing right now. A stop releases the hold
  // early; it never resets the anchor.
  typingActive: boolean;
  byteDayKey: string;
  byteDayCount: number;
  // Bumped on every delete. Idempotency keys carry the generation, and
  // work started under an older one stops instead of writing.
  generation: number;
  // When the conversation was last deleted, 0 when never. Events older
  // than the cutoff are dropped, so queued redeliveries and feed replays
  // cannot recreate wiped data.
  deletedAtMs: number;
  // The last STOP: the provider's timestamp of that message when it had
  // one (optOutDated), else when Channels received it. Only an inbound
  // sent strictly after it can re-engage.
  optOutAtMs: number;
  optOutDated: boolean;
  // When Channels received that STOP, on its own clock.
  optOutReceivedAtMs: number;
  // Moves forward on every STOP, close and delete, and never back, not
  // even when the person re-engages. Decorations (the eyes, a reply's
  // reaction) carry the epoch they were scheduled under and send only
  // while it still holds.
  decorationEpoch: number;
}

// Mano's chat background on one chat, keyed by a hash of the chat ID (so
// no raw chat ID outlives a delete). "uncertain" means an upload may have
// landed and is read back before any retry. Kept across a delete, so the
// background is never sent twice.
export type ChatBackgroundState = "uncertain" | "set" | "failed";
export interface ChatBackground {
  chatKey: string;
  state: ChatBackgroundState;
  // Uploads tried.
  attempts: number;
  // A single-flight lock, written before an upload starts: while it holds,
  // no other upload starts for this chat. Past it, an "uncertain" record
  // is read back before anything else.
  lockedUntilMs: number;
  updatedAtMs: number;
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
    typingSinceMs: 0,
    typingActive: false,
    byteDayKey: "",
    byteDayCount: 0,
    generation: 0,
    deletedAtMs: 0,
    optOutAtMs: 0,
    optOutDated: false,
    optOutReceivedAtMs: 0,
    decorationEpoch: 0,
  };
}

export interface ConversationStore {
  hasEvent(eventId: string): boolean;
  recordEvent(eventId: string, kind: string, atMs: number): void;
  // Inbound message ids, keyed separately from event ids: the same
  // message arrives once by webhook and once by reconcile under two
  // different event ids, and the DO answers it once.
  hasInboundMessage(messageId: string): boolean;
  recordInboundMessage(messageId: string, atMs: number): void;
  meta(): ConversationMeta;
  // Writes the whole row: only for a reset, never with a snapshot read
  // before an await. Every other write is patchMeta.
  saveMeta(meta: ConversationMeta): void;
  // Writes only the given fields, leaving every other field as it is now.
  patchMeta(patch: Partial<ConversationMeta>): void;
  addPending(item: PendingInbound): void;
  pending(): PendingInbound[];
  clearPending(eventIds: string[]): void;
  // Stores the crisis decision on pending pieces.
  setPendingCrisis(eventIds: string[], crisis: boolean): void;
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
  bumpTurnAttempt(turn: number, atMs: number): void;
  updateTurnAnswer(turn: number, answerJson: string, costUsd: number, atMs: number): void;
  markTurnSettled(turn: number, atMs: number): void;
  finishTurn(turn: number, atMs: number): void;
  // Finished turns, newest first.
  recentTurns(limit: number): PersistedTurn[];
  savePresentation(row: PresentationRow): void;
  pendingPresentations(): PresentationRow[];
  finishPresentation(turn: number, state: "reported" | "not_shown"): void;
  agentSend(key: string): AgentSendRow | null;
  startAgentSend(row: AgentSendRow): void;
  finishAgentSend(key: string, atMs: number, state?: "sent" | "refused" | "failed"): void;
  wipe(deletedAtMs: number): void;
  chatBackground(chatKey: string): ChatBackground | null;
  saveChatBackground(row: ChatBackground): void;
}

export class MemoryStore implements ConversationStore {
  private events = new Map<string, { kind: string; atMs: number }>();
  private inboundMessages = new Map<string, number>();
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

  hasInboundMessage(messageId: string): boolean {
    return this.inboundMessages.has(messageId);
  }

  recordInboundMessage(messageId: string, atMs: number): void {
    this.inboundMessages.set(messageId, atMs);
  }

  meta(): ConversationMeta {
    return { ...this.metaRow };
  }

  saveMeta(meta: ConversationMeta): void {
    this.metaRow = { ...meta };
  }

  patchMeta(patch: Partial<ConversationMeta>): void {
    this.metaRow = { ...this.metaRow, ...patch };
  }

  addPending(item: PendingInbound): void {
    // Missing means crisis, as on the SQL store.
    this.pendingRows.push({ ...item, crisis: item.crisis ?? true });
  }

  pending(): PendingInbound[] {
    return [...this.pendingRows];
  }

  setPendingCrisis(eventIds: string[], crisis: boolean): void {
    const ids = new Set(eventIds);
    this.pendingRows = this.pendingRows.map((p) => (ids.has(p.eventId) ? { ...p, crisis } : p));
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

  bumpTurnAttempt(turn: number, atMs: number): void {
    const row = this.turnRows.get(turn);
    if (row) this.turnRows.set(turn, { ...row, attempts: row.attempts + 1, updatedAtMs: atMs });
  }

  finishTurn(turn: number, atMs: number): void {
    const row = this.turnRows.get(turn);
    if (row) this.turnRows.set(turn, { ...row, state: "finished", updatedAtMs: atMs });
  }

  recentTurns(limit: number): PersistedTurn[] {
    return [...this.turnRows.values()]
      .filter((r) => r.state === "finished")
      .sort((a, b) => b.turn - a.turn)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  private agentSendRows = new Map<string, AgentSendRow>();
  private presentationRows = new Map<number, PresentationRow>();

  savePresentation(row: PresentationRow): void {
    if (!this.presentationRows.has(row.turn)) this.presentationRows.set(row.turn, { ...row });
  }

  pendingPresentations(): PresentationRow[] {
    return [...this.presentationRows.values()].filter((r) => r.state === "pending").map((r) => ({ ...r }));
  }

  finishPresentation(turn: number, state: "reported" | "not_shown"): void {
    const row = this.presentationRows.get(turn);
    if (row) this.presentationRows.set(turn, { ...row, state });
  }

  agentSend(key: string): AgentSendRow | null {
    return this.agentSendRows.get(key) ?? null;
  }

  startAgentSend(row: AgentSendRow): void {
    if (!this.agentSendRows.has(row.key)) this.agentSendRows.set(row.key, { ...row });
  }

  finishAgentSend(key: string, atMs: number, state: "sent" | "refused" | "failed" = "sent"): void {
    const row = this.agentSendRows.get(key);
    if (row) this.agentSendRows.set(key, { ...row, state, updatedAtMs: atMs });
  }

  // Not cleared by wipe: see ChatBackground.
  private chatBackgrounds = new Map<string, ChatBackground>();

  chatBackground(chatKey: string): ChatBackground | null {
    return this.chatBackgrounds.get(chatKey) ?? null;
  }

  saveChatBackground(row: ChatBackground): void {
    this.chatBackgrounds.set(row.chatKey, { ...row });
  }

  wipe(deletedAtMs: number): void {
    const generation = this.metaRow.generation + 1;
    const turn = this.metaRow.turn;
    this.events.clear();
    this.inboundMessages.clear();
    const decorationEpoch = this.metaRow.decorationEpoch + 1;
    this.metaRow = { ...defaultMeta(), generation, turn, deletedAtMs, decorationEpoch };
    this.pendingRows = [];
    this.outboundRows.clear();
    this.heldReceipts = [];
    this.approvalRows.clear();
    this.turnRows.clear();
    this.agentSendRows.clear();
    this.presentationRows.clear();
  }
}

export type { NormalizedEvent };
