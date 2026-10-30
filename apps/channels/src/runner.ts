// One conversation's turn runner. Pure orchestration over injected
// dependencies: the store (SQLite in the DO, memory in tests), the
// channel, the responder, files and the spend ledger. Nothing here names
// a provider or a runtime.
import {
  ChannelFailed,
  ChannelRefused,
  HANDLE_BYTES_DAILY,
  INPUT_SLACK_CHARS,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
  MAX_OUTPUT_CHARS,
  OUTBOUND_RANK,
  ResponderFailed,
  TURN_TEXT_CAP,
  finalizeReply,
  dayKeyFor,
  errName,
  estimateCostUsd,
  LinkChecker,
  MAX_PENDING_CHARS,
  handleOverLimit,
  hourKeyFor,
  idempotencyKeyFor,
  isOptIn,
  isOptOut,
  lifecycleStateFor,
  parseApprovalReply,
  sha256Hex,
  stripBlockedLinks,
  type Channel,
  type Logger,
  type NormalizedEvent,
  type OutboundState,
} from "@mano/channels";
import type { HistoryMessage, Responder } from "@mano/channels";
import { EYES, REFUSED_TAPBACK_TEXT, allowedTapback, crisisLineFor, crisisTurn, guardReply, tapbackText } from "@mano/persona";
import {
  APPROVAL_RECORDED_BUBBLE,
  BUSY_BUBBLE,
  FAILURE_BUBBLE,
  INTERIM_BUBBLE,
  INTRO_BUBBLE,
  OPT_OUT_BUBBLE,
  attachmentAck,
} from "./text.js";
import { attachmentDocumentId, fetchAttachment, saveAttachment, type FileStore } from "./files.js";

export interface SpendLedger {
  reserve(key: string, worstUsd: number): Promise<{ allowed: boolean; spentUsd: number }>;
  settle(key: string, actualUsd: number): Promise<void>;
  release(key: string): Promise<void>;
  byteReserve(key: string, bytes: number): Promise<{ allowed: boolean; bytesUsed: number }>;
  byteSettle(key: string, actualBytes: number): Promise<void>;
  byteRelease(key: string): Promise<void>;
}

export interface RunnerConfig {
  handleHash: string;
  batchMs: number;
  interimMs: number;
  // How often the typing indicator is sent again while Mano works, so it
  // stays up across the fast and deep paths.
  typingRefreshMs: number;
  budgetUsd: number;
  usdPer1kChars: number;
  maxInboundAgeMs: number;
  mediaHosts: string[];
  // A turn still working after this long gets the eyes on the person's
  // message ("Mano is on it"). A photo or a deep turn gets them at once.
  eyesAfterMs: number;
  // Mano's chat background image, set once per chat after the first
  // reply. Null leaves chats as they are.
  backgroundUrl: string | null;
}

export const DEFAULT_MEDIA_HOSTS = ["bucket.blooio.com"];

// How much of the conversation the model sees: the last few finished
// turns, oldest dropped first past the character cap.
export const HISTORY_TURNS = 6;

// Over a limit or out of budget, every message still gets the busy text
// with its safety line, up to this many per person per day. Past the
// cap only a message that might be a crisis gets a reply.
export const BUSY_DAILY_CAP = 20;

// A turn waits while the person is typing, so a burst of texts gets one
// answer, but never longer than this after they started: a stuck typing
// indicator cannot hold a reply back.
export const TYPING_HOLD_CAP_MS = 8000;
export const HISTORY_CHARS = 4000;

export const DEFAULT_RUNNER_CONFIG: Omit<RunnerConfig, "handleHash"> = {
  batchMs: 2500,
  interimMs: 20000,
  typingRefreshMs: 10000,
  budgetUsd: 5,
  usdPer1kChars: 0.001,
  maxInboundAgeMs: 5 * 60 * 1000,
  mediaHosts: DEFAULT_MEDIA_HOSTS,
  eyesAfterMs: 5000,
  backgroundUrl: null,
};

// Tries at setting the chat background before Channels gives up on it.
export const BACKGROUND_MAX_ATTEMPTS = 3;
// Blooio takes a background image of at most 10 MB.
export const BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;
const BACKGROUND_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

export interface RunnerDeps {
  store: import("./store.js").ConversationStore;
  channel: Channel;
  responder: Responder;
  files: FileStore | null;
  kekB64: string | null;
  spend: SpendLedger;
  logger: Logger;
  nowMs: () => number;
  fetchFn: typeof fetch;
  config: RunnerConfig;
  // Tells the agent an approval question reached the person, given the
  // texts the provider accepted for its turn. True when reported, false
  // when the question was not shown whole; throws to retry later.
  reportPresentation?: (
    p: { approvalId: string; approval: string; generation: number },
    sentTexts: string[],
  ) => Promise<boolean>;
}

export type HandleResult =
  | "queued"
  | "recorded"
  | "duplicate"
  | "ignored"
  | "stale"
  | "dropped"
  | "quarantined"
  | "activity"
  | "opted-out";

export type TurnResult = "ran" | "waiting" | "idle" | "running" | "stopped" | "retry";

// The conversation was deleted mid-turn: the generation moved on. The
// turn stops without writing so it cannot recreate wiped data.
export class GenerationStopped extends Error {
  constructor() {
    super("Conversation generation moved on.");
    this.name = "GenerationStopped";
  }
}

// A turn whose sends never resolved. Not an outcome: the turn row and
// its input stay, and the turn retries with backoff.
export class TurnIncomplete extends Error {
  constructor() {
    super("Turn sends unresolved.");
    this.name = "TurnIncomplete";
  }
}

export interface SendBubbleResult {
  key: string;
  state: import("@mano/channels").OutboundState;
  code: string | null;
  // True when this call performed the provider send. Resumed turns
  // re-send persisted bubbles, and only fresh sends count toward limits.
  fresh: boolean;
  // True when this call made the first terminal decision for the key
  // (sent or refused) and counted it toward the per-handle limits.
  // Replays and retries of a decided key never count again.
  counted: boolean;
}

const TERMINAL_SEND: ReadonlySet<OutboundState> = new Set(["sent", "delivered", "read", "failed", "refused"]);

// A receipt applies to a send only when both name the same chat. When
// either side omits the chat, the message ID alone decides.
export function receiptChatMatches(rowChatId: string | null, receiptChatId: string | null): boolean {
  if (rowChatId && receiptChatId) return rowChatId === receiptChatId;
  return true;
}

// Groups buffered input by destination, oldest first: one turn per chat,
// so every reply goes back to the chat its own inputs came from. Items
// with no chat fall back to the conversation's last known chat; items
// addressed only by handle form their own turn, sent channel-scoped.
export function partitionByChat(
  pending: import("./store.js").PendingInbound[],
  fallbackChatId: string | null,
): import("./store.js").PendingInbound[][] {
  const groups = new Map<string, import("./store.js").PendingInbound[]>();
  for (const item of pending) {
    const key = item.chatId || fallbackChatId || (item.to ? `to:${item.to}` : "");
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

// In a burst of two or more texts, the reply answers the one question
// that is not the latest message, shown inline under it. With no such
// question, or more than one, the reply is not threaded.
export function inlineReplyTarget(items: import("./store.js").PendingInbound[]): string | null {
  const texts = items.filter((i) => (i.text ?? "").trim().length > 0 && i.messageId);
  if (texts.length < 2) return null;
  const earlier = texts.slice(0, -1).filter((i) => /\?\s*$/.test(i.text ?? ""));
  return earlier.length === 1 && !/\?\s*$/.test(texts[texts.length - 1].text ?? "") ? (earlier[0].messageId ?? null) : null;
}

function turnTextOf(texts: string[]): string {
  return texts.join("\n");
}

// The full text of each message in a group: pieces split from one long
// text at buffer time ("evt#2", "evt#3") join back without a separator,
// separate messages with a newline.
export function rejoinPieces(items: import("./store.js").PendingInbound[]): string {
  let out = "";
  items.forEach((item, i) => {
    if (i > 0) out += /#\d+$/.test(item.eventId) ? "" : "\n";
    out += item.text ?? "";
  });
  return out;
}

// Retry backoff from a persisted attempt count: 5 seconds, doubling to
// a 5 minute ceiling. The count survives crashes, so a stuck turn or
// send backs off instead of spinning the alarm.
export function retryDelayMs(attempts: number): number {
  return Math.min(5000 * 2 ** Math.max(0, attempts - 1), 300000);
}

// Groups one chat's pending input into complete turns under the text
// cap, oldest first. Every item fits on its own (oversized texts split
// at buffer time), so every chunk is non-empty and nothing is cut.
export function chunkByTextCap(
  pending: import("./store.js").PendingInbound[],
  cap: number,
): import("./store.js").PendingInbound[][] {
  const chunks: import("./store.js").PendingInbound[][] = [];
  let current: import("./store.js").PendingInbound[] = [];
  let joinedLen = 0;
  let nonEmpty = 0;
  for (const item of pending) {
    const len = item.text?.length ?? 0;
    const sep = nonEmpty > 0 && len > 0 ? 1 : 0;
    if (current.length > 0 && joinedLen + sep + len > cap) {
      chunks.push(current);
      current = [];
      joinedLen = 0;
      nonEmpty = 0;
    }
    const freshSep = nonEmpty > 0 && len > 0 ? 1 : 0;
    current.push(item);
    joinedLen += freshSep + len;
    if (len > 0) nonEmpty += 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Splits one oversized text into cap-sized pieces for buffering. The
// pieces rejoin in order across turns; attachments stay on the first.
export function splitTextCap(text: string, cap: number): string[] {
  if (text.length <= cap) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += cap) out.push(text.slice(i, i + cap));
  return out;
}

// Out-of-order delivery events resolve by rank, with two guards: failed
// and refused never move again, and a failure never overwrites proof of
// delivery.
export function advanceLifecycle(current: OutboundState, next: OutboundState): OutboundState | null {
  if (current === "failed" || current === "refused") return null;
  if (next === "failed") return current === "delivered" || current === "read" ? null : "failed";
  return OUTBOUND_RANK[next] > OUTBOUND_RANK[current] ? next : null;
}

// After a STOP whose timestamp the provider gave, any inbound sent
// strictly after it re-engages (the product rule: any new message). After
// an undated STOP, only START or a message Channels received at least
// REENGAGE_AFTER_UNDATED_MS later can.
const REENGAGE_AFTER_UNDATED_MS = 60_000;

function reengages(meta: import("./store.js").ConversationMeta, sentAtMs: number | null, text: string, nowMs: number): boolean {
  if (meta.optOutDated) return sentAtMs !== null && sentAtMs > meta.optOutAtMs;
  return isOptIn(text) || nowMs >= meta.optOutReceivedAtMs + REENGAGE_AFTER_UNDATED_MS;
}

export class ConversationRunner {
  private deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  private get store() {
    return this.deps.store;
  }

  private logHandle(): string {
    return this.deps.config.handleHash;
  }

  // Records one event and buffers inbound texts for the next turn. Returns
  // "queued" when the caller must (re)schedule the batch alarm.
  async handleEvent(event: NormalizedEvent, source: "webhook" | "reconcile"): Promise<HandleResult> {
    const { store, logger, nowMs, config } = this.deps;
    // The person's typing holds the pending turn, with one fixed deadline:
    // the first start for that turn plus the cap. A stop releases the hold
    // early. A duplicate, a stale start or any later start, even after a
    // stop, never moves the deadline.
    if (event.kind === "typing.started" || event.kind === "typing.stopped") {
      if (store.hasEvent(event.id)) return "duplicate";
      store.recordEvent(event.id, event.kind, nowMs());
      if (event.direction === "outbound") return "recorded";
      if (event.kind === "typing.stopped") {
        store.patchMeta({ typingActive: false });
      } else {
        const at = event.occurredAtMs ?? nowMs();
        if (nowMs() - at >= TYPING_HOLD_CAP_MS) return "recorded";
        // With nothing pending there is no turn to hold yet: a new burst.
        const fresh = store.meta().typingSinceMs === 0 || store.pending().length === 0;
        store.patchMeta(fresh ? { typingSinceMs: nowMs(), typingActive: true } : { typingActive: true });
      }
      return "recorded";
    }
    if (event.kind === "ignored") {
      if (!store.hasEvent(event.id)) store.recordEvent(event.id, event.kind, nowMs());
      return "recorded";
    }
    if (store.hasEvent(event.id)) return "duplicate";
    // Webhook and reconcile deliver the same inbound message under two
    // different event ids (evt_ webhook id vs evt_ feed id): dedupe by
    // type plus message id so it is answered once.
    if (event.kind === "message.received" && event.direction === "inbound" && event.messageId) {
      if (store.hasInboundMessage(event.messageId)) {
        store.recordEvent(event.id, event.kind, nowMs());
        return "duplicate";
      }
      store.recordInboundMessage(event.messageId, nowMs());
    }
    store.recordEvent(event.id, event.kind, nowMs());

    // Groups are recorded and never answered. A group reply could carry a
    // private answer into a shared chat, so only 1:1 chats reach a turn.
    if (event.group) {
      logger.info("group_skipped", { handle: this.logHandle(), eventId: event.id });
      return "recorded";
    }
    // STOP is honored before every check below, dated or not, fresh or
    // stale, even from before a delete: it only ever makes Mano quieter.
    if (event.kind === "message.received" && event.direction === "inbound") {
      const optOutText = event.text ?? "";
      if (optOutText && isOptOut(optOutText) && event.attachments.length === 0 && (event.chatId || event.handle)) {
        return this.applyOptOut(event);
      }
    }
    // Events older than the deletion cutoff are recorded and dropped:
    // queued redeliveries and feed replays from before a delete cannot
    // recreate wiped data, and redeliveries dedupe on the recorded ID.
    // An undated event cannot prove it is new, so it is dropped too.
    const cutoff = store.meta().deletedAtMs;
    const when = event.occurredAtMs;
    if (cutoff > 0 && (when === null || when <= 0 || when < cutoff)) {
      logger.info("event_dropped", { handle: this.logHandle(), eventId: event.id });
      return "dropped";
    }

    if (event.kind === "message.received" && event.direction === "inbound") {
      if (when === null || when <= 0) {
        logger.info("inbound_quarantined", { handle: this.logHandle(), eventId: event.id });
        return "quarantined";
      }
      const ageMs = nowMs() - when;
      if (ageMs > config.maxInboundAgeMs) {
        logger.info("inbound_stale", { handle: this.logHandle(), eventId: event.id, ageMs });
        return "stale";
      }
      if (!event.chatId && !event.handle) {
        logger.warn("inbound_unroutable", { handle: this.logHandle(), eventId: event.id });
        return "recorded";
      }
      const text = event.text ?? "";
      // After STOP, only an inbound the person sent after it re-engages.
      // One sent before it (or at the same instant) and delivered late, by
      // webhook or by the reconcile feed, is recorded and nothing more.
      const optedOut = store.meta();
      if (optedOut.optedOut && !reengages(optedOut, when, text, nowMs())) {
        logger.info("inbound_before_optout", { handle: this.logHandle(), eventId: event.id });
        return "recorded";
      }
      // Bound what waits for the batch alarm before buffering it. Past
      // the cap the new input is recorded and dropped; the turn answers
      // what already waits.
      const buffered = store.pending().reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
      if (buffered + text.length > MAX_PENDING_CHARS) {
        logger.info("inbound_capped", { handle: this.logHandle(), eventId: event.id, buffered });
        return "recorded";
      }
      const meta = store.meta();
      store.patchMeta({
        chatId: event.chatId ?? meta.chatId,
        to: event.handle ?? meta.to,
        closed: false,
        optedOut: false,
        lastInboundMs: nowMs(),
      });
      // Oversized texts split into cap-sized pieces now, so the turn
      // runner never has to cut. Continuation pieces take derived IDs;
      // the event still dedupes on its own ID.
      const pieces = text ? splitTextCap(text, TURN_TEXT_CAP) : [null];
      pieces.forEach((piece, i) => {
        store.addPending({
          eventId: i === 0 ? event.id : `${event.id}#${i + 1}`,
          receivedAtMs: nowMs(),
          chatId: event.chatId ?? meta.chatId ?? "",
          to: event.handle ?? meta.to ?? "",
          text: piece,
          attachments: i === 0 ? event.attachments : [],
          fromReconcile: source === "reconcile",
          messageId: i === 0 ? event.messageId : null,
        });
      });
      logger.info("inbound_queued", {
        handle: this.logHandle(),
        eventId: event.id,
        source,
        hasText: text.length > 0,
        attachments: event.attachments.length,
      });
      return "queued";
    }

    const lifecycle = lifecycleStateFor(event.kind);
    if (lifecycle && event.messageId) {
      const row = store.outboundByMessageId(event.messageId);
      if (row && receiptChatMatches(row.chatId, event.chatId)) {
        this.applyLifecycle(row.key, row.state, row.code, lifecycle, event.errorCode, event.id);
      } else if (!row) {
        // The receipt beat the send response. Hold it by message ID; the
        // send path applies it when the response lands.
        store.holdReceipt({
          messageId: event.messageId,
          chatId: event.chatId,
          state: lifecycle,
          code: event.errorCode,
          eventId: event.id,
          atMs: nowMs(),
        });
        logger.info("receipt_held", { handle: this.logHandle(), eventId: event.id, state: lifecycle });
      } else {
        logger.info("receipt_unmatched", { handle: this.logHandle(), eventId: event.id });
      }
      return "recorded";
    }

    // A tapback from the person is acknowledgement only. It never answers
    // an approval here: Engine and the Agent own approvals, so Channels
    // records it and passes it on.
    if (event.kind === "reaction") {
      const onMano = event.messageId ? store.outboundByMessageId(event.messageId) !== null : false;
      logger.info("reaction_received", {
        handle: this.logHandle(),
        eventId: event.id,
        reaction: event.reaction?.value ?? null,
        action: event.reaction?.action ?? null,
        onMano,
      });
      return "activity";
    }

    if (event.kind === "chat.closed") {
      store.patchMeta({ closed: true });
      logger.info("conversation_closed", { handle: this.logHandle(), eventId: event.id });
      return "recorded";
    }

    return "recorded";
  }

  // Applies one held or live receipt to a send, in rank order.
  private applyLifecycle(
    key: string,
    current: OutboundState,
    currentCode: string | null,
    next: OutboundState,
    errorCode: string | null,
    eventId: string,
  ): void {
    const advanced = advanceLifecycle(current, next);
    if (!advanced) return;
    this.store.updateOutbound(key, {
      state: advanced,
      code: advanced === "failed" ? (errorCode ?? "delivery_failed") : currentCode,
      updatedAtMs: this.deps.nowMs(),
    });
    this.deps.logger.info("outbound_lifecycle", {
      handle: this.logHandle(),
      eventId,
      key,
      state: advanced,
      code: errorCode ?? null,
    });
  }

  // Applies receipts that arrived before the send response. Each names
  // the message, and the chat when the provider gave one; a receipt for
  // another chat is dropped instead of applied.
  private applyHeldReceipts(messageId: string, chatId: string | null): void {
    for (const held of this.store.takeReceipts(messageId)) {
      if (!receiptChatMatches(chatId, held.chatId)) {
        this.deps.logger.info("receipt_unmatched", { handle: this.logHandle(), eventId: held.eventId });
        continue;
      }
      const row = this.store.outboundByMessageId(messageId);
      if (row) this.applyLifecycle(row.key, row.state, row.code, held.state, held.code, held.eventId);
    }
  }

  private async applyOptOut(event: NormalizedEvent): Promise<HandleResult> {
    const { store, logger, nowMs } = this.deps;
    const before = store.meta();
    // The cutoff: the provider's timestamp of the STOP, else Channels'
    // receive time.
    const dated = event.occurredAtMs !== null && event.occurredAtMs > 0;
    if (before.optedOut) {
      // A repeat STOP sends nothing, but the cutoff only ever moves
      // forward to it. Once any STOP was undated, the stricter undated
      // rule holds, timed from the latest STOP.
      store.patchMeta({
        optOutAtMs: Math.max(before.optOutAtMs, dated ? event.occurredAtMs! : nowMs()),
        optOutDated: before.optOutDated && dated,
        optOutReceivedAtMs: nowMs(),
      });
      return "opted-out";
    }
    const meta = {
      optedOut: true,
      optOutAtMs: dated ? event.occurredAtMs! : nowMs(),
      optOutDated: dated,
      optOutReceivedAtMs: nowMs(),
      chatId: event.chatId ?? before.chatId,
      to: event.handle ?? before.to,
      turn: before.turn + 1,
    };
    store.patchMeta(meta);
    logger.info("opted_out", { handle: this.logHandle(), eventId: event.id, turn: meta.turn });
    await this.sendBubble({
      turn: meta.turn,
      part: 0,
      tag: "optout",
      text: OPT_OUT_BUBBLE,
      chatId: meta.chatId,
      to: meta.to,
      force: true,
    });
    return "opted-out";
  }

  // Runs one turn when the batch window has passed since the last inbound
  // message. One turn at a time: while running, new inbound waits.
  // Pending input is answered per chat, so every reply goes back to the
  // chat its own inputs came from. Each turn is persisted before any
  // external call; pending input clears only at a final state, and an
  // interrupted turn resumes from its row on the next alarm.
  async runDueTurn(): Promise<TurnResult> {
    // Set synchronously, before the first await, so a concurrent caller
    // sees "running" even while this turn is still resolving. Same
    // instance re-entry means a turn is genuinely in flight; an
    // unfinished row seen by a fresh instance means the last attempt
    // died and must resume. (The DO also serializes across requests.)
    if (this.active) return "running";
    this.active = true;
    try {
      return await this.runDueTurnInner();
    } finally {
      this.active = false;
    }
  }

  private async runDueTurnInner(): Promise<TurnResult> {
    const { store, nowMs, logger } = this.deps;
    // Fast path stays synchronous when nothing needs resolving, so the
    // batch decision below sees the same state as the caller.
    if (store.outbounds().some((r) => r.state === "uncertain" || r.state === "sending")) {
      try {
        await this.resolveUncertain();
      } catch (err) {
        if (err instanceof GenerationStopped) return "stopped";
        throw err;
      }
    }
    const generation = store.meta().generation;
    const unfinished = store.unfinishedTurn();
    if (unfinished) {
      const items = JSON.parse(unfinished.itemsJson) as import("./store.js").PendingInbound[];
      logger.info("turn_resumed", { handle: this.logHandle(), turn: unfinished.turn });
      try {
        await this.runGuarded(async () => {
          await this.runTurnBody(unfinished.turn, items, unfinished, generation);
          this.finishTurnRow(unfinished.turn, items);
        });
      } catch (err) {
        if (err instanceof GenerationStopped) {
          logger.info("turn_stopped", { handle: this.logHandle(), turn: unfinished.turn });
          return "stopped";
        }
        return this.noteInfraError(unfinished.turn, err);
      }
      return this.afterTurns();
    }
    // Stale flag with no turn row behind it: a crash before the first
    // persist. Clear it and proceed; nothing was sent yet.
    if (store.meta().running) store.patchMeta({ running: false });
    // Only awaits when a report is owed. Everything after it reads the
    // meta fresh: STOP, a close or a delete can land during the await.
    if (this.deps.reportPresentation && store.pendingPresentations().length > 0) await this.reportPresentations();
    const meta = store.meta();
    const pending = store.pending();
    if (pending.length === 0) return this.needsRetry() ? "retry" : "idle";
    if (nowMs() - meta.lastInboundMs < this.deps.config.batchMs) return "waiting";
    if (meta.typingActive && meta.typingSinceMs > 0 && nowMs() - meta.typingSinceMs < TYPING_HOLD_CAP_MS) return "waiting";
    if (meta.typingSinceMs > 0 || meta.typingActive) {
      // This turn runs now: the next burst gets its own deadline.
      store.patchMeta({ typingSinceMs: 0, typingActive: false });
    }
    // A turn finishes only after a persisted final outcome. An
    // infrastructure error keeps the turn row and its input and returns
    // "retry": the alarm re-arms with backoff and the turn resumes.
    let retried = false;
    try {
      await this.runGuarded(async () => {
        for (const group of partitionByChat(pending, store.meta().chatId)) {
          const groupCrisis = crisisTurn(rejoinPieces(group));
          for (const chunk of chunkByTextCap(group, TURN_TEXT_CAP)) {
            const items = groupCrisis ? chunk.map((item) => ({ ...item, crisis: true })) : chunk;
            const turnMeta = store.meta();
            const turn = turnMeta.turn + 1;
            store.patchMeta({ turn });
            const chatId = [...items].reverse().find((i) => i.chatId)?.chatId ?? turnMeta.chatId;
            const to = [...items].reverse().find((i) => i.to)?.to ?? turnMeta.to;
            try {
              store.startTurn({
                turn,
                itemsJson: JSON.stringify(items),
                chatId,
                to,
                answerJson: null,
                costUsd: null,
                costSettled: false,
                attempts: 0,
                state: "started",
                createdAtMs: nowMs(),
                updatedAtMs: nowMs(),
              });
              await this.runTurnBody(turn, items, null, generation);
              this.finishTurnRow(turn, items);
            } catch (err) {
              if (err instanceof GenerationStopped) throw err;
              await this.noteInfraError(turn, err);
              retried = true;
              return;
            }
          }
        }
      });
    } catch (err) {
      if (err instanceof GenerationStopped) {
        logger.info("turn_stopped", { handle: this.logHandle() });
        return "stopped";
      }
      throw err;
    }
    if (retried) return "retry";
    return this.afterTurns();
  }

  // An infrastructure error (ledger, network, storage) is not an
  // outcome: the turn row and its input stay, and the caller re-arms.
  // The spend hold releases only when no paid work happened yet (no
  // answer persisted): once the model ran, the hold stays until the
  // retry's settlement succeeds, so the cap cannot be passed meanwhile.
  // The release itself is best-effort: a failing ledger must not wedge
  // the retry, which reserves idempotently under the same key.
  private async noteInfraError(turn: number, err: unknown): Promise<"retry"> {
    const { store, logger, nowMs } = this.deps;
    store.bumpTurnAttempt(turn, nowMs());
    const row = store.unfinishedTurn();
    if (!row || row.turn !== turn || row.costUsd === null) {
      try {
        await this.deps.spend.release(`${this.deps.config.handleHash}:${turn}`);
      } catch (releaseErr) {
        logger.warn("turn_release_failed", {
          handle: this.logHandle(),
          turn,
          err: errName(releaseErr),
        });
      }
    }
    logger.warn("turn_infra_error", {
      handle: this.logHandle(),
      turn,
      err: errName(err),
    });
    return "retry";
  }

  // Work remains when a turn never finished or a send never resolved.
  // The alarm must re-arm until none remains, even with no new input.
  needsRetry(): boolean {
    if (this.store.unfinishedTurn()) return true;
    if (this.deps.reportPresentation && this.store.pendingPresentations().length > 0) return true;
    return this.store.outbounds().some((r) => r.state === "uncertain" || r.state === "sending");
  }

  // Backoff for the next attempt: the unfinished turn's count, else the
  // most-retried stuck send.
  retryAfterMs(): number {
    const unfinished = this.store.unfinishedTurn();
    if (unfinished) return retryDelayMs(Math.max(1, unfinished.attempts));
    const stuck = this.store.outbounds().filter((r) => r.state === "uncertain" || r.state === "sending");
    const attempts = stuck.reduce((max, r) => Math.max(max, r.attempts), 0);
    return retryDelayMs(Math.max(1, attempts));
  }

  // Reports each approval question whose turn's sends are all resolved.
  // A report that fails stays pending; needsRetry re-arms the alarm, and
  // the next run sends it again. The person's YES counts only once the
  // agent has the report.
  private async reportPresentations(): Promise<void> {
    const { store, logger } = this.deps;
    const report = this.deps.reportPresentation;
    if (!report) return;
    const outbounds = store.outbounds();
    for (const p of store.pendingPresentations()) {
      const rows = outbounds.filter((r) => r.turn === p.turn);
      if (rows.length === 0 || rows.some((r) => r.state === "uncertain" || r.state === "sending")) continue;
      const sent = rows
        .filter((r) => r.state === "sent" || r.state === "delivered" || r.state === "read")
        .sort((a, b) => a.part - b.part)
        .map((r) => r.text);
      try {
        const shown = await report({ approvalId: p.approvalId, approval: p.approval, generation: p.generation }, sent);
        store.finishPresentation(p.turn, shown ? "reported" : "not_shown");
      } catch (err) {
        logger.warn("presentation_report_failed", { handle: this.logHandle(), turn: p.turn, err: errName(err) });
      }
    }
  }

  private afterTurns(): TurnResult {
    return this.needsRetry() ? "retry" : "ran";
  }

  private checkGeneration(generation: number): void {
    if (this.store.meta().generation !== generation) throw new GenerationStopped();
  }

  private active = false;

  // The running turn's eyes, so its tapback can swap them.
  private eyes: Eyes | null = null;

  private eyesFor(turn: number, chatId: string | null, messageId: string | null, crisis: boolean, generation: number): Eyes {
    const { channel, logger, store } = this.deps;
    let landed: Promise<boolean> | null = null;
    return {
      turn,
      messageId,
      put: (why: string): void => {
        if (landed || crisis || !chatId || !messageId) return;
        const meta = store.meta();
        if (meta.optedOut || meta.closed || meta.generation !== generation) return;
        landed = channel.react(chatId, messageId, EYES).then(
          () => {
            logger.info("eyes_sent", { handle: this.logHandle(), turn, why });
            return true;
          },
          (err: unknown) => {
            logger.warn("eyes_failed", { handle: this.logHandle(), turn, err: errName(err) });
            return false;
          },
        );
      },
      takeOff: async (): Promise<void> => {
        if (!landed || !(await landed) || !chatId || !messageId) return;
        await this.bestEffort("eyes_remove_failed", () => channel.unreact(chatId, messageId, EYES));
      },
      settled: async (): Promise<void> => {
        await landed;
      },
    };
  }

  // Mano's chat background goes on once per chat, after a reply reached
  // the person, never on a crisis turn, after STOP or on a closed chat.
  // It is decoration: a failure is logged, counted and never retried
  // past BACKGROUND_MAX_ATTEMPTS, and it never touches the reply.
  private async maybeSetBackground(turn: number, chatId: string | null, crisis: boolean, generation: number): Promise<void> {
    const { store, channel, config, logger, nowMs } = this.deps;
    const url = config.backgroundUrl;
    if (!url || !channel.setBackground || !chatId || crisis) return;
    const meta = store.meta();
    if (meta.backgroundSetAtMs > 0 || meta.backgroundAttempts >= BACKGROUND_MAX_ATTEMPTS) return;
    if (meta.optedOut || meta.closed || meta.generation !== generation) return;
    if (!store.outbounds().some((r) => r.turn === turn && r.state === "sent" && r.tag !== "react")) return;
    store.patchMeta({ backgroundAttempts: meta.backgroundAttempts + 1 });
    try {
      const image = await this.fetchBackground(url);
      const now = store.meta();
      if (now.optedOut || now.closed || now.generation !== generation) return;
      await channel.setBackground(chatId, image);
      store.patchMeta({ backgroundSetAtMs: nowMs() });
      logger.info("background_set", { handle: this.logHandle(), turn });
    } catch (err) {
      logger.warn("background_failed", { handle: this.logHandle(), turn, err: errName(err) });
    }
  }

  // Our own image, from config, checked like any link before it is used.
  private async fetchBackground(url: string): Promise<Blob> {
    const check = await new LinkChecker({ fetchFn: this.deps.fetchFn }).checkUrl(url);
    if (!check.ok) throw new Error(`background link blocked: ${check.reason}`);
    const res = await this.deps.fetchFn(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!res.ok) throw new Error(`background fetch failed: ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!BACKGROUND_TYPES.has(type)) throw new Error("background is not an image");
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > BACKGROUND_MAX_BYTES) throw new Error("background size out of range");
    return new Blob([bytes], { type });
  }

  private async runGuarded(fn: () => Promise<void>): Promise<void> {
    const { store } = this.deps;
    store.patchMeta({ running: true });
    try {
      await fn();
    } finally {
      store.patchMeta({ running: false });
    }
  }

  private finishTurnRow(turn: number, items: import("./store.js").PendingInbound[]): void {
    this.store.finishTurn(turn, this.deps.nowMs());
    this.store.clearPending(items.map((p) => p.eventId));
  }

  private async runTurnBody(
    turn: number,
    items: import("./store.js").PendingInbound[],
    resumed: import("./store.js").PersistedTurn | null,
    generation: number,
  ): Promise<void> {
    const { store, logger, nowMs, config } = this.deps;
    this.checkGeneration(generation);
    const meta = store.meta();
    const chatId = resumed?.chatId ?? [...items].reverse().find((i) => i.chatId)?.chatId ?? meta.chatId;
    const to = resumed?.to ?? [...items].reverse().find((i) => i.to)?.to ?? meta.to;
    if (!chatId && !to) {
      logger.warn("turn_unroutable", { handle: this.logHandle(), turn });
      return;
    }
    // A resumed turn with a persisted answer skips straight to sending
    // it: same keys, same text, no second model call.
    if (resumed?.answerJson) {
      await this.settleResumedCost(turn, resumed);
      await this.sendBubbles(turn, JSON.parse(resumed.answerJson) as import("./store.js").AnswerBubble[], chatId, to, 0, generation);
      this.checkSendsResolved(turn, generation);
      await this.reportPresentations();
      return;
    }
    const texts = items.map((i) => i.text).filter((t): t is string => !!t && t.length > 0);
    const attachments = items.flatMap((i) => i.attachments);

    // One crisis detector for every path, classified before approvals,
    // admission and any model work, on the whole message even when the
    // buffer split it. It is broad on purpose: a match makes the reply
    // name 988 and 911, and over-triggering is accepted.
    const crisis = crisisTurn(texts.join("\n")) || items.some((i) => i.crisis === true);
    // A crisis turn never sends the friendly intro, and later turns do not
    // send it either.
    if (crisis && !meta.introduced) store.patchMeta({ introduced: true });

    const approval = texts.length === 1 && attachments.length === 0 ? parseApprovalReply(texts[0]) : null;
    if (approval && store.pendingApprovals(nowMs()).length > 0) {
      // A crisis reply goes first; the decision is still recorded.
      const crisisBubbles = crisis ? await this.finalize(turn, "", true, turnTextOf(texts)) : [];
      if (crisisBubbles.length > 0) await this.sendBubbles(turn, crisisBubbles, chatId, to, 0, generation);
      const recordedPart = crisisBubbles.length + 1;
      const answered = await this.answerApproval(approval.code, approval.decision, turn, chatId, to, recordedPart);
      if (answered) {
        store.updateTurnAnswer(turn, JSON.stringify([...crisisBubbles, { part: recordedPart, tag: "", text: APPROVAL_RECORDED_BUBBLE }]), 0, nowMs());
        store.markTurnSettled(turn, nowMs());
        return;
      }
    }

    const over = handleOverLimit(
      { hourKey: meta.hourKey, hourCount: meta.hourCount, dayKey: meta.dayKey, dayCount: meta.dayCount },
      nowMs(),
    );
    // Chunks arrive under the cap by construction (buffer-time split
    // plus chunkByTextCap), so the join is never cut: every input
    // reaches the responder exactly once, across as many turns as needed.
    const turnText = texts.join("\n");
    const history = this.history(meta.introduced);
    const historyChars = history.reduce((sum, h) => sum + h.text.length, 0);
    const { responder } = this.deps;
    const reserveKey = `${config.handleHash}:${turn}`;
    const worstUsd = estimateCostUsd(
      (turnText.length + historyChars + (responder.inputSlackChars ?? INPUT_SLACK_CHARS)) * responder.maxAttempts,
      responder.maxOutputChars ?? MAX_OUTPUT_CHARS,
      config.usdPer1kChars,
    );
    const budgeted = over ? { allowed: false, spentUsd: 0 } : await this.deps.spend.reserve(reserveKey, worstUsd);
    if (over || !budgeted.allowed) {
      logger.info("turn_limited", {
        handle: this.logHandle(),
        turn,
        reason: over ?? "budget",
        spentUsd: budgeted.spentUsd,
        crisis,
      });
      if (crisis) {
        // No model and no cost: the deterministic crisis reply, past any limit.
        const bubbles = await this.finalize(turn, "", true, turnText);
        store.updateTurnAnswer(turn, JSON.stringify(bubbles), 0, nowMs());
        store.markTurnSettled(turn, nowMs());
        await this.sendBubbles(turn, bubbles, chatId, to, 0, generation);
        this.checkSendsResolved(turn, generation);
      } else {
        const noticed = await this.sendBusy(turn, chatId, to, nowMs());
        store.updateTurnAnswer(turn, JSON.stringify(noticed ? [{ part: 0, tag: "busy", text: BUSY_BUBBLE }] : []), 0, nowMs());
        store.markTurnSettled(turn, nowMs());
      }
      // Over a limit nothing is downloaded: admission failed, so the
      // turn's attachments are dropped with the turn.
      if (attachments.length > 0) {
        logger.info("attachments_dropped", { handle: this.logHandle(), turn, count: attachments.length });
      }
      return;
    }

    // The eyes say Mano is on it: at once for a photo, before typing
    // shows, and otherwise when the turn routes deep or runs past
    // eyesAfterMs. They are decoration, never awaited before the reply.
    const latest = [...items].reverse().find((i) => i.messageId)?.messageId ?? null;
    const eyes = this.eyesFor(turn, chatId, latest, crisis, generation);
    this.eyes = eyes;
    if (attachments.length > 0) eyes.put("attachment");
    let eyesTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => eyes.put("slow"), config.eyesAfterMs);
    const stopEyesTimer = (): void => {
      clearTimeout(eyesTimer);
      eyesTimer = undefined;
    };

    // Keepalive refreshes run one at a time. Before the final stop, no
    // new refresh starts and the one in flight finishes, so typing can
    // never come back on after Mano is done.
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    let refreshing: Promise<void> = Promise.resolve();
    let typingDone = false;
    if (chatId) {
      await this.bestEffort("mark_read", () => this.deps.channel.markRead(chatId));
      await this.bestEffort("typing_started", () => this.deps.channel.setTyping(chatId, "started"));
      typingTimer = setInterval(() => {
        refreshing = refreshing.then(() =>
          typingDone ? undefined : this.bestEffort("typing_started", () => this.deps.channel.setTyping(chatId, "started")),
        );
      }, config.typingRefreshMs);
    }
    try {
      const saved = await this.saveAttachments(turn, attachments);
      const bubbles: import("./store.js").AnswerBubble[] = [];
      // A crisis turn opens with the crisis line, never the friendly intro.
      if (!meta.introduced && !crisis) bubbles.push({ part: 0, tag: "", text: INTRO_BUBBLE });
      if (saved > 0) bubbles.push({ part: 0, tag: "ack", text: attachmentAck(saved) });
      if (turnText) {
        this.checkGeneration(generation);
        // The turn's latest message: what the agent orders a YES by.
        const receivedAtMs = Math.max(...items.map((i) => i.receivedAtMs));
        const answer = await this.respondWithInterim(turn, turnText, history, saved, chatId, to, generation, crisis, receivedAtMs, () => eyes.put("deep"));
        stopEyesTimer();
        if (answer.ok) {
          // Links come out before splitting, and each final bubble is
          // checked again: a split must never leave an unchecked link
          // behind. The persisted bubbles are final and capped. A crisis
          // turn's final bubbles must still name 988 and 911.
          // A tapback is decoration. It carries the reply alone only when
          // the rules allow it and it has a message to go on; even then a
          // fallback text is persisted with it, sent if the tapback fails.
          const tapback = allowedTapback(answer.tapback, turnText, crisis);
          const latest = [...items].reverse().find((i) => i.messageId)?.messageId ?? null;
          const routable = tapback !== null && latest !== null && chatId !== null;
          const hasText = answer.text.trim().length > 0;
          let reply: string | null = answer.text;
          if (!hasText && crisis) reply = "";
          else if (!hasText && routable) reply = null;
          else if (!hasText && tapback) reply = tapbackText(tapback);
          else if (!hasText && answer.tapback) reply = REFUSED_TAPBACK_TEXT;
          const answered = reply === null ? [] : await this.finalize(turn, reply, crisis, turnText);
          const replyTo = inlineReplyTarget(items);
          if (replyTo && answered[0]) answered[0] = { ...answered[0], replyTo };
          bubbles.push(...answered);
          if (routable && tapback && latest) {
            bubbles.push({ part: 0, tag: "react", text: tapback, messageId: latest, fallback: hasText ? null : tapbackText(tapback) });
          }
          // Persisted with the answer, so a resumed send reports it too.
          if (answer.presentation) store.savePresentation({ turn, generation, state: "pending", ...answer.presentation });
          store.updateTurnAnswer(turn, JSON.stringify(bubbles), answer.costUsd, nowMs());
          await this.deps.spend.settle(reserveKey, answer.costUsd);
          store.markTurnSettled(turn, nowMs());
        } else {
          bubbles.push(...(await this.finalize(turn, crisis ? "" : FAILURE_BUBBLE, crisis, turnText)));
          store.updateTurnAnswer(turn, JSON.stringify(bubbles), answer.costUsd, nowMs());
          await this.deps.spend.settle(reserveKey, answer.costUsd);
          store.markTurnSettled(turn, nowMs());
        }
      } else {
        // A textless turn costs nothing: settle zero to release the hold
        // instead of holding the whole budget.
        await this.deps.spend.settle(reserveKey, 0);
        store.updateTurnAnswer(turn, JSON.stringify(bubbles), 0, nowMs());
        store.markTurnSettled(turn, nowMs());
      }
      stopEyesTimer();
      this.checkGeneration(generation);
      await this.sendBubbles(turn, bubbles, chatId, to, saved, generation);
      this.checkSendsResolved(turn, generation);
      await this.reportPresentations();
      await this.maybeSetBackground(turn, chatId, crisis, generation);
    } finally {
      stopEyesTimer();
      await eyes.settled();
      this.eyes = null;
      typingDone = true;
      clearInterval(typingTimer);
      await refreshing;
      if (chatId) await this.bestEffort("typing_stopped", () => this.deps.channel.setTyping(chatId, "stopped"));
    }
  }

  // Every reply, model or fixed, becomes its bubbles through
  // finalizeReply (@mano/channels), the same function Quality runs. It
  // logs which guard rules fired and how many links it removed, never
  // the text. sendBubble's own guard pass then changes nothing, since
  // the guard is idempotent.
  private async finalize(turn: number, text: string, crisis: boolean, personText: string): Promise<import("./store.js").AnswerBubble[]> {
    const model = this.deps.responder.model;
    const final = await finalizeReply(text, {
      modelIds: model ? [model] : [],
      crisis,
      checker: new LinkChecker({ fetchFn: this.deps.fetchFn }),
      crisisLine: crisisLineFor(personText),
    });
    if (final.changes.length > 0) {
      this.deps.logger.info("voice_guarded", { handle: this.logHandle(), turn, part: 1, tag: "", changes: final.changes.join(",") });
    }
    if (final.removed > 0) this.deps.logger.warn("reply_links_removed", { handle: this.logHandle(), turn, removed: final.removed });
    return final.bubbles.map((t, i) => ({ part: i + 1, tag: "", text: t }));
  }


  // A turn is finished only when every send resolved. Anything still
  // uncertain or sending aborts the turn: the row and its input stay,
  // and the retry looks each send up again.
  private checkSendsResolved(turn: number, generation: number): void {
    this.checkGeneration(generation);
    const stuck = this.store.outbounds().some((r) => r.turn === turn && (r.state === "uncertain" || r.state === "sending"));
    if (stuck) throw new TurnIncomplete();
  }

  private async settleResumedCost(turn: number, resumed: import("./store.js").PersistedTurn): Promise<void> {
    if (resumed.costSettled || resumed.costUsd === null) return;
    await this.deps.spend.settle(`${this.deps.config.handleHash}:${turn}`, resumed.costUsd);
    this.store.markTurnSettled(turn, this.deps.nowMs());
  }

  private async sendBubbles(
    turn: number,
    bubbles: import("./store.js").AnswerBubble[],
    chatId: string | null,
    to: string | null,
    saved: number,
    generation: number,
  ): Promise<void> {
    const { store, logger } = this.deps;
    // Bubbles arrive final: model text was sanitized before splitting
    // and capped by the splitter, and the static texts carry no links
    // (pinned by test). Nothing here mutates them, so a replayed turn
    // sends byte-identical bubbles under the same keys.
    let fresh = 0;
    // Text goes first: a tapback never holds back a message.
    for (const bubble of [...bubbles.filter((b) => b.tag !== "react"), ...bubbles.filter((b) => b.tag === "react")]) {
      if (bubble.tag === "react") {
        await this.sendTapback(turn, bubble, chatId, to, generation);
        continue;
      }
      const row = await this.sendBubble({ turn, part: bubble.part, tag: bubble.tag, text: bubble.text, chatId, to, generation, replyTo: bubble.replyTo ?? null });
      if (row.fresh) fresh += 1;
      if (bubble.tag === "" && bubble.part === 0 && row.state === "sent") {
        store.patchMeta({ introduced: true });
      }
    }
    // Limits count inside the one send path; the turn only reports.
    logger.info("turn_ran", { handle: this.logHandle(), turn, bubbles: bubbles.length, sent: fresh, saved });
  }

  // Runs the responder. A deep turn's heads-up goes out the moment the
  // responder has it, after the intro on a first contact, and takes the
  // place of the interim notice.
  // A tapback has its own outbound row, so a resumed turn knows whether
  // it landed. It is not a message and never counts toward limits. Right
  // before every attempt, including a replay, it checks the generation,
  // opt-out and closed state. When it fails, its persisted fallback text
  // goes through the one send path under its own key.
  private async sendTapback(
    turn: number,
    bubble: import("./store.js").AnswerBubble,
    chatId: string | null,
    to: string | null,
    generation: number,
  ): Promise<void> {
    const { store, channel, logger, nowMs, config } = this.deps;
    const key = idempotencyKeyFor(config.handleHash, generation, turn, bubble.part, "react");
    const sendFallback = async (): Promise<void> => {
      if (bubble.fallback) await this.sendBubble({ turn, part: bubble.part, tag: "react-fallback", text: bubble.fallback, chatId, to, generation });
    };
    const prior = store.outboundByKey(key);
    if (prior?.state === "sent" || prior?.state === "refused") return;
    if (prior?.state === "failed") return sendFallback();
    this.checkGeneration(generation);
    const meta = store.meta();
    if (!prior) {
      store.addOutbound({
        key, turn, part: bubble.part, tag: "react", text: bubble.text, attempts: 0, state: "planned", code: null,
        chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
      });
    }
    if (meta.optedOut || meta.closed || !chatId || !bubble.messageId) {
      const code = meta.optedOut ? "opted_out" : meta.closed ? "conversation_closed" : "unroutable";
      store.updateOutbound(key, { state: "refused", code, updatedAtMs: nowMs() });
      logger.info("tapback_suppressed", { handle: this.logHandle(), turn, code });
      return;
    }
    try {
      // One reaction per message: the eyes come off before the reply's own.
      if (this.eyes?.turn === turn && this.eyes.messageId === bubble.messageId) await this.eyes.takeOff();
      await channel.react(chatId, bubble.messageId, bubble.text as import("@mano/channels").Tapback);
      this.checkGeneration(generation);
      store.updateOutbound(key, { state: "sent", updatedAtMs: nowMs() });
      logger.info("tapback_sent", { handle: this.logHandle(), turn, tapback: bubble.text });
    } catch (err) {
      if (err instanceof GenerationStopped) throw err;
      store.updateOutbound(key, { state: "failed", code: "tapback_failed", updatedAtMs: nowMs() });
      logger.warn("tapback_failed", { handle: this.logHandle(), turn, err: errName(err) });
      await sendFallback();
    }
  }

  private async respondWithInterim(
    turn: number,
    turnText: string,
    history: HistoryMessage[],
    attachmentCount: number,
    chatId: string | null,
    to: string | null,
    generation: number,
    crisis: boolean,
    receivedAtMs: number,
    onDeep: () => void = () => {},
  ): Promise<
    | {
        ok: true;
        text: string;
        costUsd: number;
        tapback: import("@mano/channels").Tapback | null;
        presentation?: { approvalId: string; approval: string };
      }
    | { ok: false; costUsd: number }
  > {
    const { responder, config, logger } = this.deps;
    let done = false;
    let interimSent = false;
    const timer = setTimeout(() => {
      if (done || interimSent) return;
      try {
        this.checkGeneration(generation);
      } catch {
        return;
      }
      interimSent = true;
      void this
        .sendBubble({ turn, part: 0, tag: "interim", text: INTERIM_BUBBLE, chatId, to, generation })
        .catch((err: unknown) => logger.warn("interim_failed", { handle: this.logHandle(), turn, err: errName(err) }));
    }, config.interimMs);
    const attemptCost = (inputChars: number, attempts: number): number =>
      estimateCostUsd(inputChars * attempts, 0, config.usdPer1kChars);
    try {
      const onHeadsUp = async (text: string): Promise<void> => {
        if (!crisis) onDeep();
        if (done || interimSent || crisis) return;
        interimSent = true;
        try {
          await this.sendHeadsUp(turn, text, chatId, to, generation);
        } catch (err) {
          logger.warn("heads_up_failed", { handle: this.logHandle(), turn, err: errName(err) });
        }
      };
      const result = await responder.respond(
        { texts: [turnText], attachmentCount, history, turnKey: { generation, turn }, receivedAtMs },
        { onHeadsUp },
      );
      const costUsd =
        result.model === "stand-in" ? 0 : estimateCostUsd(result.inputChars * result.attempts, result.outputChars, config.usdPer1kChars);
      logger.info("turn_answered", { handle: this.logHandle(), turn, model: result.model, attempts: result.attempts });
      return { ok: true, text: result.text, costUsd, tapback: result.tapback ?? null, presentation: result.presentation };
    } catch (err) {
      logger.warn("responder_failed", {
        handle: this.logHandle(),
        turn,
        err: errName(err),
        reason: err instanceof ResponderFailed ? err.reason : null,
      });
      const costUsd = err instanceof ResponderFailed ? attemptCost(err.inputChars, err.attempts) : 0;
      return { ok: false, costUsd };
    } finally {
      done = true;
      clearTimeout(timer);
    }
  }

  // The heads-up is model text, so it gets the same voice guard and
  // link check as the final answer before it is sent.
  private async sendHeadsUp(turn: number, raw: string, chatId: string | null, to: string | null, generation: number): Promise<void> {
    const checked = await stripBlockedLinks(this.guard(raw, { turn, part: 0, tag: "headsup" }), new LinkChecker({ fetchFn: this.deps.fetchFn }));
    if (checked.removed > 0) this.deps.logger.warn("reply_links_removed", { handle: this.logHandle(), turn, removed: checked.removed });
    const text = checked.text;
    this.checkGeneration(generation);
    if (!this.store.meta().introduced) {
      const intro = await this.sendBubble({ turn, part: 0, tag: "", text: INTRO_BUBBLE, chatId, to, generation });
      if (intro.state === "sent") {
        this.store.patchMeta({ introduced: true });
      }
    }
    await this.sendBubble({ turn, part: 0, tag: "headsup", text, chatId, to, generation });
    this.deps.logger.info("heads_up_sent", { handle: this.logHandle(), turn });
  }

  // The conversation so far as role messages, oldest first: each
  // finished turn's texts and the bubbles Mano planned for it. On a
  // first contact the intro goes last, since it is sent with this turn's
  // reply, so the model does not introduce Mano twice.
  private history(introduced: boolean): HistoryMessage[] {
    const messages: HistoryMessage[] = [];
    for (const row of this.store.recentTurns(HISTORY_TURNS).reverse()) {
      const items = JSON.parse(row.itemsJson) as import("./store.js").PendingInbound[];
      const person = items.map((i) => i.text ?? "").filter((t) => t.length > 0).join("\n");
      const bubbles = row.answerJson ? (JSON.parse(row.answerJson) as import("./store.js").AnswerBubble[]) : [];
      const mano = bubbles.filter((b) => b.tag !== "react").map((b) => b.text).join(" ");
      if (person) messages.push({ role: "person", text: person });
      if (mano) messages.push({ role: "mano", text: mano });
    }
    let chars = messages.reduce((sum, m) => sum + m.text.length, 0);
    while (messages.length > 0 && chars > HISTORY_CHARS) chars -= messages.shift()!.text.length;
    if (!introduced) messages.push({ role: "mano", text: INTRO_BUBBLE });
    return messages;
  }



  private guardOptions(): { modelIds: string[] } {
    const model = this.deps.responder.model;
    return { modelIds: model ? [model] : [] };
  }

  private isVoiced(text: string): boolean {
    return guardReply(text, this.guardOptions()).changes.length === 0;
  }

  // The voice guard. Logs which rules fired, never the text.
  private guard(text: string, where: { turn: number; part: number; tag: string }): string {
    const guarded = guardReply(text, this.guardOptions());
    if (guarded.changes.length > 0) {
      const { turn, part, tag } = where;
      this.deps.logger.info("voice_guarded", { handle: this.logHandle(), turn, part, tag, changes: guarded.changes.join(",") });
    }
    return guarded.text;
  }

  // The day's busy count rides in busyNoticeKey ("busy:<day>:<count>"),
  // so no schema change is needed. A key from an older deploy counts as
  // zero for the day.
  private async sendBusy(turn: number, chatId: string | null, to: string | null, nowMs: number): Promise<boolean> {
    const meta = this.store.meta();
    const day = dayKeyFor(nowMs);
    const match = /^busy:([^:]+):(\d+)$/.exec(meta.busyNoticeKey ?? "");
    const count = match && match[1] === day ? Number(match[2]) : 0;
    if (count >= BUSY_DAILY_CAP) return false;
    this.store.patchMeta({ busyNoticeKey: `busy:${day}:${count + 1}` });
    await this.sendBubble({ turn, part: 0, tag: "busy", text: BUSY_BUBBLE, chatId, to });
    return true;
  }


  // Downloads run only after the turn passed admission, and only inside
  // the per-handle and global daily byte budgets. Each file reserves the
  // worst case up front and settles its actual size after.
  private async saveAttachments(turn: number, attachments: import("@mano/channels").EventAttachment[]): Promise<number> {
    const { store, files, kekB64, fetchFn, config, logger, nowMs, spend } = this.deps;
    if (attachments.length === 0) return 0;
    if (!files || !kekB64) {
      logger.warn("attachments_unsaved", { handle: this.logHandle(), turn, reason: "no_storage" });
      return 0;
    }
    let saved = 0;
    for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
      const meta = store.meta();
      const byteDay = dayKeyFor(nowMs());
      const usedToday = meta.byteDayKey === byteDay ? meta.byteDayCount : 0;
      if (usedToday + MAX_ATTACHMENT_BYTES > HANDLE_BYTES_DAILY) {
        logger.warn("attachment_capped", { handle: this.logHandle(), turn, scope: "handle" });
        continue;
      }
      const byteKey = `${config.handleHash}:${turn}:${saved}`;
      const reservation = await spend.byteReserve(byteKey, MAX_ATTACHMENT_BYTES);
      if (!reservation.allowed) {
        logger.warn("attachment_capped", { handle: this.logHandle(), turn, scope: "global" });
        continue;
      }
      try {
        const fetched = await fetchAttachment(attachment, {
          fetchFn,
          checker: new LinkChecker({ fetchFn }),
          mediaHosts: config.mediaHosts,
        });
        if (!fetched.bytes) {
          await spend.byteRelease(byteKey);
          logger.warn("attachment_refused", { handle: this.logHandle(), turn, reason: fetched.reason });
          continue;
        }
        const bytes = fetched.bytes;
        const documentId = await attachmentDocumentId(turn, saved, attachment.url);
        await saveAttachment(files, kekB64, config.handleHash, documentId, bytes);
        await spend.byteSettle(byteKey, bytes.byteLength);
        const counted = store.meta();
        store.patchMeta({
          byteDayCount: (counted.byteDayKey === byteDay ? counted.byteDayCount : 0) + bytes.byteLength,
          byteDayKey: byteDay,
        });
        saved += 1;
      } catch (err) {
        await spend.byteRelease(byteKey);
        logger.warn("attachment_failed", { handle: this.logHandle(), turn, err: errName(err) });
      }
    }
    return saved;
  }

  // The one send path. Every bubble goes through here with its
  // deterministic key, and every text passes the voice guard first; the
  // guard is deterministic, so a resumed turn sends the same bytes. A
  // send whose outcome is unknown is marked uncertain, never failed: the
  // worker looks the message up (or replays its key, which the provider
  // answers from its stored original) before deciding, retrying on later
  // alarms until it knows. Only a send the
  // provider definitively rejected (failed) ends there.
  async sendBubble(opts: {
    turn: number;
    part: number;
    tag: string;
    text: string;
    chatId: string | null;
    to: string | null;
    force?: boolean;
    generation?: number;
    replyTo?: string | null;
  }): Promise<SendBubbleResult> {
    const { store, channel, logger, nowMs, config } = this.deps;
    opts = { ...opts, text: this.guard(opts.text, { turn: opts.turn, part: opts.part, tag: opts.tag }) };
    const generation = opts.generation ?? store.meta().generation;
    this.checkGeneration(generation);
    const key = idempotencyKeyFor(config.handleHash, generation, opts.turn, opts.part, opts.tag);
    // First terminal decisions count toward the per-handle limits here,
    // in the one send path, so every caller (turns, interim, busy and
    // approval notices) counts the same way. Sent and refused both
    // count; anything undecided or already decided does not.
    const finish = (result: SendBubbleResult): SendBubbleResult => {
      if (result.counted) this.countSent(1, nowMs());
      return result;
    };
    const prior = store.outboundByKey(key);
    if (prior && TERMINAL_SEND.has(prior.state)) {
      return finish({ key, state: prior.state, code: prior.code, fresh: false, counted: false });
    }
    if (prior && (prior.state === "sending" || prior.state === "uncertain")) {
      return this.resolveUncertainKey(key, { ...opts, text: prior.text, chatId: prior.chatId ?? opts.chatId }, generation);
    }
    const meta = store.meta();
    if (!opts.force && (meta.closed || meta.optedOut)) {
      const code = meta.closed ? "conversation_closed" : "opted_out";
      if (!prior) {
        store.addOutbound({
          key, turn: opts.turn, part: opts.part, tag: opts.tag, text: opts.text, attempts: 0, state: "refused", code,
          chatId: opts.chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
        });
      } else {
        store.updateOutbound(key, { state: "refused", code, updatedAtMs: nowMs() });
      }
      logger.info("send_suppressed", { handle: this.logHandle(), key, code });
      return finish({ key, state: "refused", code, fresh: false, counted: false });
    }
    if (!prior) {
      store.addOutbound({
        key, turn: opts.turn, part: opts.part, tag: opts.tag, text: opts.text, attempts: 0, state: "planned", code: null,
        chatId: opts.chatId, messageId: null, replyTo: opts.replyTo ?? null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
      });
    }
    store.updateOutbound(key, { state: "sending", updatedAtMs: nowMs() });
    try {
      const result = await channel.send({ to: opts.to ?? "", chatId: opts.chatId, text: opts.text, idempotencyKey: key, replyTo: opts.replyTo ?? null });
      // The conversation may have been deleted mid-send. Never write the
      // result into a newer generation.
      this.checkGeneration(generation);
      store.updateOutbound(key, {
        state: "sent", messageId: result.messageId, chatId: result.chatId, updatedAtMs: nowMs(),
      });
      this.applyHeldReceipts(result.messageId, result.chatId);
      logger.info("send_sent", { handle: this.logHandle(), key, message: result.messageId, duplicate: result.duplicate });
      return finish({ key, state: "sent", code: null, fresh: true, counted: true });
    } catch (err) {
      if (err instanceof GenerationStopped) throw err;
      if (err instanceof ChannelRefused) {
        store.updateOutbound(key, { state: "refused", code: err.code, updatedAtMs: nowMs() });
        logger.warn("send_refused", { handle: this.logHandle(), key, code: err.code, status: err.status });
        return finish({ key, state: "refused", code: err.code, fresh: false, counted: true });
      }
      if (err instanceof ChannelFailed) {
        store.updateOutbound(key, { state: "failed", code: err.code, updatedAtMs: nowMs() });
        logger.warn("send_failed", { handle: this.logHandle(), key, code: err.code, status: err.status });
        return finish({ key, state: "failed", code: err.code, fresh: false, counted: true });
      }
      // Any other send error (timeout, network, 5xx, unexpected) may
      // have landed: never terminal. Mark uncertain, look the message
      // up or replay its key, and let the turn retry on backoff.
      store.updateOutbound(key, { state: "uncertain", updatedAtMs: nowMs() });
      logger.warn("send_uncertain", { handle: this.logHandle(), key });
      return this.resolveUncertainKey(key, opts, generation);
    }
  }

  // Resolves one uncertain send: a message the provider already named
  // gets looked up first, and only a send with no record replays the
  // same key and body. Anything still unknown stays uncertain for the
  // next alarm.
  private async resolveUncertainKey(
    key: string,
    opts: { text: string; chatId: string | null; to: string | null },
    generation: number,
  ): Promise<SendBubbleResult> {
    const { store, channel, logger, nowMs } = this.deps;
    const finish = (result: SendBubbleResult): SendBubbleResult => {
      if (result.counted) this.countSent(1, nowMs());
      return result;
    };
    const row = store.outboundByKey(key);
    let lookupFailed = false;
    if (row?.messageId && row.chatId) {
      try {
        const status = await channel.lookupMessage(row.chatId, row.messageId);
        if (status) {
          this.checkGeneration(generation);
          store.updateOutbound(key, { state: "sent", updatedAtMs: nowMs() });
          this.applyHeldReceipts(status.messageId, status.chatId);
          logger.info("send_reconciled", { handle: this.logHandle(), key, message: status.messageId, via: "lookup" });
          return finish({ key, state: "sent", code: null, fresh: true, counted: true });
        }
      } catch (err) {
        if (err instanceof GenerationStopped) throw err;
        lookupFailed = true;
        logger.warn("lookup_failed", { handle: this.logHandle(), key, err: errName(err) });
      }
    }
    // A row stored before the voice guard shipped may hold text the guard
    // would change. Its key is bound to that exact payload, so it is
    // never rewritten and never replayed. Never replaying is not the same
    // as giving up: while the lookup is down the row stays uncertain, so
    // the lookup retries with backoff and a delivery receipt can still
    // settle it. It ends failed only once nothing can find it.
    if (!this.isVoiced(opts.text)) {
      if (lookupFailed) {
        const attempts = (store.outboundByKey(key)?.attempts ?? 0) + 1;
        store.updateOutbound(key, { state: "uncertain", attempts, updatedAtMs: nowMs() });
        logger.warn("send_still_uncertain", { handle: this.logHandle(), key, attempts });
        return finish({ key, state: "uncertain", code: null, fresh: false, counted: false });
      }
      store.updateOutbound(key, { state: "failed", code: "unguarded_legacy", updatedAtMs: nowMs() });
      logger.warn("send_failed", { handle: this.logHandle(), key, code: "unguarded_legacy", status: null });
      return finish({ key, state: "failed", code: "unguarded_legacy", fresh: false, counted: false });
    }
    // Read fresh after the lookup's await: a STOP, a close or a delete
    // that landed meanwhile stops the replay. The opt-out confirmation
    // itself still goes out. While the lookup is down the row stays
    // uncertain, since the first attempt may have landed.
    this.checkGeneration(generation);
    const now = store.meta();
    if (row?.tag !== "optout" && (now.optedOut || now.closed)) {
      const code = now.closed ? "conversation_closed" : "opted_out";
      if (lookupFailed) {
        store.updateOutbound(key, { state: "uncertain", attempts: (row?.attempts ?? 0) + 1, updatedAtMs: nowMs() });
        return finish({ key, state: "uncertain", code: null, fresh: false, counted: false });
      }
      store.updateOutbound(key, { state: "refused", code, updatedAtMs: nowMs() });
      logger.info("send_suppressed", { handle: this.logHandle(), key, code });
      return finish({ key, state: "refused", code, fresh: false, counted: false });
    }
    try {
      // The replay carries the stored reply target: the key is bound to
      // the exact body, so it must not change.
      const result = await channel.send({ to: opts.to ?? "", chatId: opts.chatId, text: opts.text, idempotencyKey: key, replyTo: row?.replyTo ?? null });
      this.checkGeneration(generation);
      store.updateOutbound(key, {
        state: "sent", messageId: result.messageId, chatId: result.chatId, updatedAtMs: nowMs(),
      });
      this.applyHeldReceipts(result.messageId, result.chatId);
      logger.info("send_reconciled", { handle: this.logHandle(), key, message: result.messageId, duplicate: result.duplicate, via: "replay" });
      return finish({ key, state: "sent", code: null, fresh: true, counted: true });
    } catch (err) {
      if (err instanceof GenerationStopped) throw err;
      if (err instanceof ChannelRefused) {
        store.updateOutbound(key, { state: "refused", code: err.code, updatedAtMs: nowMs() });
        return finish({ key, state: "refused", code: err.code, fresh: false, counted: true });
      }
      if (err instanceof ChannelFailed) {
        store.updateOutbound(key, { state: "failed", code: err.code, updatedAtMs: nowMs() });
        logger.warn("send_failed", { handle: this.logHandle(), key, code: err.code, status: err.status });
        return finish({ key, state: "failed", code: err.code, fresh: false, counted: true });
      }
      const attempts = (store.outboundByKey(key)?.attempts ?? 0) + 1;
      store.updateOutbound(key, { state: "uncertain", attempts, updatedAtMs: nowMs() });
      logger.warn("send_still_uncertain", { handle: this.logHandle(), key, attempts });
      return finish({ key, state: "uncertain", code: null, fresh: false, counted: false });
    }
  }

  // Retries every uncertain or stuck sending row with its stored
  // text. Runs on each alarm tick before turns, so an uncertain send
  // resolves as soon as the provider answers again. Sending rows are
  // safe to take: turns never overlap, so a sending row seen here is a
  // crash remnant, not a live send.
  async resolveUncertain(): Promise<number> {
    const generation = this.store.meta().generation;
    let resolved = 0;
    for (const row of this.store.outbounds()) {
      if (row.state !== "uncertain" && row.state !== "sending") continue;
      const result = await this.resolveUncertainKey(
        row.key,
        { text: row.text, chatId: row.chatId, to: this.store.meta().to },
        generation,
      );
      if (result.state === "sent" || result.state === "refused") resolved += 1;
    }
    return resolved;
  }

  private countSent(sent: number, nowMs: number): void {
    if (sent === 0) return;
    const meta = this.store.meta();
    const hourKey = hourKeyFor(nowMs);
    const dayKey = dayKeyFor(nowMs);
    this.store.patchMeta({
      hourCount: meta.hourKey === hourKey ? meta.hourCount + sent : sent,
      dayCount: meta.dayKey === dayKey ? meta.dayCount + sent : sent,
      hourKey,
      dayKey,
    });
  }

  private async bestEffort(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.logger.warn(name, { handle: this.logHandle(), err: errName(err) });
    }
  }

  async requestApproval(opts: { id: string; code: string; summary: string; ttlMs: number }): Promise<void> {
    const now = this.deps.nowMs();
    this.store.addApproval({
      id: opts.id,
      codeHash: await sha256Hex(opts.code),
      summary: opts.summary,
      status: "pending",
      decision: null,
      createdAtMs: now,
      expiresAtMs: now + opts.ttlMs,
    });
    this.deps.logger.info("approval_requested", { handle: this.logHandle(), approval: opts.id });
  }

  // Sends one agent-started text (reminder, nudge) through the normal
  // outbound path: consent and STOP refuse, per-handle limits and the
  // spend ledger apply, links are checked, and every bubble carries its
  // deterministic key. The agent's key dedupes redeliveries: a retry
  // resumes the same turn, so a crash between claim and send can neither
  // lose nor double the text. The delivery belongs to the deletion
  // generation the agent saw when it made it; that generation is fixed
  // before the first await and persisted with the row, and any change
  // stops the send, so a deletion can never be followed by an old text.
  // Budget refusal returns instead of throwing so the caller answers 429
  // and the agent retries later; anything else terminal (unknown,
  // closed, opted out, deleted) is a handled 200.
  async sendAgentText(opts: { key: string; text: string; generation: number }): Promise<{
    sent: boolean;
    reason?: "empty" | "unknown" | "closed" | "opted_out" | "budget" | "deleted" | "refused" | "failed";
    duplicate?: boolean;
  }> {
    const { store, logger, nowMs, config } = this.deps;
    const text = opts.text.trim().slice(0, TURN_TEXT_CAP);
    if (!text) return { sent: false, reason: "empty" };
    const prior = store.agentSend(opts.key);
    if (prior?.state === "sent") return { sent: true, duplicate: true };
    if (prior?.state === "refused" || prior?.state === "failed") return { sent: false, reason: prior.state };
    const generation = prior ? prior.generation : opts.generation;
    const meta = store.meta();
    if (meta.generation !== generation) return { sent: false, reason: "deleted" };
    if (meta.optedOut) return { sent: false, reason: "opted_out" };
    if (meta.closed) return { sent: false, reason: "closed" };
    const chatId = meta.chatId;
    const to = meta.to;
    if (!chatId && !to) return { sent: false, reason: "unknown" };
    let turn: number;
    if (prior) {
      turn = prior.turn;
    } else {
      turn = store.meta().turn + 1;
      store.patchMeta({ turn });
      store.startAgentSend({ key: opts.key, turn, generation, state: "sending", createdAtMs: nowMs(), updatedAtMs: nowMs() });
    }
    const over = handleOverLimit(
      { hourKey: meta.hourKey, hourCount: meta.hourCount, dayKey: meta.dayKey, dayCount: meta.dayCount },
      nowMs(),
    );
    const reserveKey = `${config.handleHash}:agent:${opts.key}`;
    const costUsd = estimateCostUsd(text.length, 0, config.usdPer1kChars);
    const budgeted = over ? { allowed: false, spentUsd: 0 } : await this.deps.spend.reserve(reserveKey, costUsd);
    if (over || !budgeted.allowed) {
      logger.info("agent_send_limited", {
        handle: this.logHandle(),
        turn,
        reason: over ?? "budget",
        spentUsd: budgeted.spentUsd,
      });
      return { sent: false, reason: "budget" };
    }
    try {
      this.checkGeneration(generation);
      // The same finalizeReply pass as every reply (it logs removed links).
      const bubbles: import("./store.js").AnswerBubble[] = (await this.finalize(turn, text, false, "")).map((b) => ({ ...b, tag: "agent" }));
      this.checkGeneration(generation);
      await this.sendBubbles(turn, bubbles, chatId, to, 0, generation);
      this.checkSendsResolved(turn, generation);
      // Sent only when the provider accepted every bubble; a refusal or a
      // definite failure is final and reported as not sent.
      const states = store.outbounds().filter((r) => r.turn === turn).map((r) => r.state);
      const outcome: "sent" | "refused" | "failed" = states.includes("refused")
        ? "refused"
        : states.includes("failed")
          ? "failed"
          : "sent";
      await this.deps.spend.settle(reserveKey, outcome === "sent" ? costUsd : 0);
      store.finishAgentSend(opts.key, nowMs(), outcome);
      logger.info("agent_sent", { handle: this.logHandle(), turn, bubbles: bubbles.length, outcome });
      return outcome === "sent" ? { sent: true } : { sent: false, reason: outcome };
    } catch (err) {
      try {
        await this.deps.spend.release(reserveKey);
      } catch (releaseErr) {
        logger.warn("agent_release_failed", { handle: this.logHandle(), turn, err: errName(releaseErr) });
      }
      if (err instanceof GenerationStopped) return { sent: false, reason: "deleted" };
      throw err;
    }
  }

  private async answerApproval(
    code: string,
    decision: "yes" | "no",
    turn: number,
    chatId: string | null,
    to: string | null,
    part = 1,
  ): Promise<boolean> {
    const { store, logger, nowMs } = this.deps;
    const codeHash = await sha256Hex(code);
    const match = store.pendingApprovals(nowMs()).find((a) => a.codeHash === codeHash);
    if (!match) return false;
    store.answerApproval(match.id, decision);
    logger.info("approval_answered", { handle: this.logHandle(), approval: match.id, decision });
    await this.sendBubble({ turn, part, tag: "", text: APPROVAL_RECORDED_BUBBLE, chatId, to });
    return true;
  }
}

// The eyes on one turn's latest message.
interface Eyes {
  turn: number;
  messageId: string | null;
  // Puts them on, once, unless it is a crisis, the chat is closed or the
  // person opted out. Never awaited by the turn.
  put(why: string): void;
  // Takes them off before another reaction goes on the same message.
  takeOff(): Promise<void>;
  // Waits for a reaction call still in flight.
  settled(): Promise<void>;
}
