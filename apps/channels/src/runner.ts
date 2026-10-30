// One conversation's turn runner. Pure orchestration over injected
// dependencies: the store (SQLite in the DO, memory in tests), the
// channel, the responder, files and the spend ledger. Nothing here names
// a provider or a runtime.
import { Decorations } from "./decorations.js";
import type { ChatBackground } from "./store.js";
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
import { EYES, allowedTapback, crisisLineFor, crisisTurn, decideCrisis, eyesAllowed, guardReply, type CrisisCheck } from "@mano/persona";
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
  // One switch for every reaction Mano adds, the eyes included.
  reactionsEnabled: boolean;
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
  reactionsEnabled: true,
  backgroundUrl: null,
};

// Tries at setting the chat background before Channels gives up on it.
export const BACKGROUND_MAX_ATTEMPTS = 3;
// Blooio takes a background image of at most 10 MB.
export const BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;
// How long one upload holds the per-chat lock: longer than any
// decoration may run, so a live upload always finishes first.
export const BACKGROUND_LOCK_MS = 2 * 60 * 1000;
// The background record's key: a hash of the chat ID, so no raw chat ID
// outlives a delete.
export async function backgroundKey(chatId: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`chat-background:${chatId}`));
}
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
  // Eyes and background work, run outside the turn. The Durable Object
  // passes one that lives across requests, so STOP and a delete can
  // cancel work a previous request started.
  decorations?: Decorations;
  // The model check for one short health question (decideCrisis). Null
  // or missing fails closed: every such question gets the crisis line.
  crisisCheck?: CrisisCheck | null;
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
      store.patchMeta({ closed: true, decorationEpoch: store.meta().decorationEpoch + 1 });
      this.decorations.cancelAll("closed");
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
        decorationEpoch: before.decorationEpoch + 1,
      });
      this.decorations.cancelAll("opted_out");
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
    store.patchMeta({ ...meta, decorationEpoch: before.decorationEpoch + 1 });
    // Nothing decorative goes out after STOP, not even work already started.
    this.decorations.cancelAll("opted_out");
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
    if (store.outbounds().some((r) => openSend(r))) {
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
          // One crisis decision on the whole message, before any split, and
          // the same decision on every chunk (Sol's fourth review): a split
          // can never cut a crisis word into pieces nobody checks.
          const groupText = rejoinPieces(group);
          // The decoration epoch is read before this first await, so a STOP
          // or close during the check is never missed by the turn.
          const epoch = store.meta().decorationEpoch;
          const decision = await decideCrisis(groupText, this.deps.crisisCheck ?? null);
          if (decision.reason !== "floor") {
            logger.info("crisis_check", { handle: this.logHandle(), crisis: decision.crisis, reason: decision.reason, ms: decision.ms });
          }
          for (const chunk of chunkByTextCap(group, TURN_TEXT_CAP)) {
            const items = chunk.map((item) => ({ ...item, crisis: decision.crisis }));
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
              await this.runTurnBody(turn, items, null, generation, epoch);
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
    return this.store.outbounds().some((r) => openSend(r));
  }

  // Backoff for the next attempt: the unfinished turn's count, else the
  // most-retried stuck send.
  retryAfterMs(): number {
    const unfinished = this.store.unfinishedTurn();
    if (unfinished) return retryDelayMs(Math.max(1, unfinished.attempts));
    const stuck = this.store.outbounds().filter((r) => openSend(r));
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
      const rows = outbounds.filter((r) => r.turn === p.turn && !DECORATION_TAGS.has(r.tag));
      if (rows.length === 0 || rows.some((r) => openSend(r))) continue;
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

  private ownDecorations: Decorations | null = null;

  private get decorations(): Decorations {
    if (this.deps.decorations) return this.deps.decorations;
    this.ownDecorations ??= new Decorations({ onError: (name, err) => this.deps.logger.warn("decoration_failed", { name, err: errName(err) }) });
    return this.ownDecorations;
  }

  // Why a decoration must not go out right now, read fresh from the store
  // immediately before the call: the conversation was deleted, STOP or a
  // close came after it was scheduled (the decoration epoch moved), the
  // person opted out, or the chat closed.
  private decorationBlock(generation: number, epoch: number): "generation" | "epoch" | "opted_out" | "conversation_closed" | null {
    const meta = this.store.meta();
    if (meta.generation !== generation) return "generation";
    // STOP, a close or a delete since the work was scheduled: dropped,
    // even when the person has re-engaged since.
    if (meta.decorationEpoch !== epoch) return "epoch";
    if (meta.optedOut) return "opted_out";
    if (meta.closed) return "conversation_closed";
    return null;
  }

  // The eyes are a status signal ("on it"), not a sentiment: they go on
  // once, on a slow turn's target message, unless it is a crisis, a
  // reaction text, or STOP or a close came since the turn started. Bad
  // news does not stop them. They are fire-and-forget work outside the
  // turn, sent at most once (their row is written as "sending" before
  // the call, so a retried or resumed turn never sends them again), and
  // never taken off. Once they are placed, no other reaction goes on that
  // message.
  private eyesFor(turn: number, chatId: string | null, target: Target | null, crisis: boolean, generation: number, epoch: number): Eyes {
    const { channel, logger, store, config, nowMs } = this.deps;
    const eyes: Eyes = {
      placed: false,
      put: (why: string): void => {
        if (eyes.placed || !config.reactionsEnabled || !chatId || !target || !eyesAllowed(target.text, crisis)) return;
        if (this.decorationBlock(generation, epoch)) return;
        eyes.placed = true;
        const key = idempotencyKeyFor(config.handleHash, generation, turn, 0, "eyes");
        this.decorations.run("eyes", async () => {
          // Read fresh right before the call.
          if (!config.reactionsEnabled || this.decorationBlock(generation, epoch) || store.outboundByKey(key)) return;
          store.addOutbound({
            key, turn, part: 0, tag: "eyes", text: EYES, attempts: 0, state: "sending", code: null,
            chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
          });
          try {
            await channel.react(chatId, target.messageId, EYES);
            if (store.meta().generation === generation) store.updateOutbound(key, { state: "sent", updatedAtMs: nowMs() });
            logger.info("eyes_sent", { handle: this.logHandle(), turn, why });
          } catch (err) {
            if (store.meta().generation === generation) store.updateOutbound(key, { state: "failed", code: "eyes_dropped", updatedAtMs: nowMs() });
            logger.warn("eyes_dropped", { handle: this.logHandle(), turn, err: errName(err) });
          }
        });
      },
    };
    // A run of this turn that crashed may already have put them on.
    if (store.outboundByKey(idempotencyKeyFor(config.handleHash, generation, turn, 0, "eyes"))) eyes.placed = true;
    return eyes;
  }

  // Mano's chat background goes on once per chat, after a reply reached
  // the person, never on a crisis turn, after STOP or on a closed chat.
  // It runs outside the turn. An upload that may have landed is read back
  // before any retry; only a known failure is retried, at most
  // BACKGROUND_MAX_ATTEMPTS uploads per chat.
  private async setBackgroundOnce(chatId: string, generation: number, epoch: number, signal: AbortSignal): Promise<void> {
    const { store, channel, config, logger, nowMs } = this.deps;
    const url = config.backgroundUrl;
    if (!url || !channel.setBackground || this.decorationBlock(generation, epoch)) return;
    const chatKey = await backgroundKey(chatId);
    const busy = (row: ChatBackground | null): boolean => row?.state === "set" || (row !== null && row.lockedUntilMs > nowMs());
    let row = store.chatBackground(chatKey);
    if (busy(row)) return;
    if (row?.state === "uncertain") {
      // A lock that ran out with no outcome: read the chat back first.
      if (!channel.hasBackground) return;
      const landed = await channel.hasBackground(chatId, signal);
      row = store.chatBackground(chatKey);
      if (busy(row) || row?.state !== "uncertain") return;
      row = { ...row, state: landed ? "set" : "failed", updatedAtMs: nowMs() };
      store.saveChatBackground(row);
      logger.info("background_reconciled", { handle: this.logHandle(), landed });
      if (landed) return;
    }
    const attempts = row?.attempts ?? 0;
    if (attempts >= BACKGROUND_MAX_ATTEMPTS || this.decorationBlock(generation, epoch)) return;
    // Check and lock with no await between them: the single-flight lock is
    // persisted before anything is fetched or uploaded.
    store.saveChatBackground({ chatKey, state: "uncertain", attempts: attempts + 1, lockedUntilMs: nowMs() + BACKGROUND_LOCK_MS, updatedAtMs: nowMs() });
    const finish = (state: ChatBackground["state"], counted: boolean): void =>
      store.saveChatBackground({ chatKey, state, attempts: counted ? attempts + 1 : attempts, lockedUntilMs: 0, updatedAtMs: nowMs() });
    let image: Blob;
    try {
      image = await this.fetchBackground(url, signal);
    } catch (err) {
      // Nothing was uploaded: a known failure that does not count.
      finish("failed", false);
      logger.warn("background_failed", { handle: this.logHandle(), err: errName(err), stage: "fetch" });
      return;
    }
    if (signal.aborted || this.decorationBlock(generation, epoch)) {
      finish("failed", false);
      return;
    }
    try {
      await channel.setBackground(chatId, image, signal);
      finish("set", true);
      logger.info("background_set", { handle: this.logHandle() });
    } catch (err) {
      // A known failure is retried later; an uncertain one is read back.
      finish(err instanceof ChannelFailed ? "failed" : "uncertain", true);
      logger.warn("background_failed", { handle: this.logHandle(), err: errName(err), known: err instanceof ChannelFailed });
    }
  }

  // Our own image, from config, through the same capped, streamed and
  // host-checked download as an attachment, cancelled past 10 MB.
  private async fetchBackground(url: string, signal: AbortSignal): Promise<Blob> {
    const host = new URL(url).hostname;
    const fetched = await fetchAttachment(
      { url },
      { fetchFn: this.deps.fetchFn, checker: new LinkChecker({ fetchFn: this.deps.fetchFn }), mediaHosts: [host], maxBytes: BACKGROUND_MAX_BYTES, signal },
    );
    if (fetched.bytes === null) throw new Error(`background fetch failed: ${fetched.reason}`);
    if (!BACKGROUND_TYPES.has(fetched.contentType)) throw new Error("background is not an image");
    if (fetched.bytes.byteLength === 0) throw new Error("background is empty");
    return new Blob([fetched.bytes], { type: fetched.contentType });
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
    // The decoration epoch read before the turn's first await; a resumed
    // turn reads it now.
    startEpoch?: number,
  ): Promise<void> {
    const { store, logger, nowMs, config } = this.deps;
    this.checkGeneration(generation);
    const meta = store.meta();
    // Captured before the turn's first await and carried everywhere: a
    // decoration this turn schedules sends only while it still holds.
    const epoch = startEpoch ?? meta.decorationEpoch;
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
      await this.sendBubbles(turn, JSON.parse(resumed.answerJson) as import("./store.js").AnswerBubble[], chatId, to, 0, generation, epoch);
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
    // The decision was made once on the whole message before it was
    // split, and every chunk carries it. A turn persisted before that
    // (no decision on its items) takes the keyword floor, which errs
    // toward crisis.
    const crisis = items.every((i) => typeof i.crisis === "boolean")
      ? items.some((i) => i.crisis === true)
      : crisisTurn(texts.join("\n"));
    // A crisis turn never sends the friendly intro, and later turns do not
    // send it either.
    if (crisis && !meta.introduced) store.patchMeta({ introduced: true });

    const approval = texts.length === 1 && attachments.length === 0 ? parseApprovalReply(texts[0]) : null;
    if (approval && store.pendingApprovals(nowMs()).length > 0) {
      // A crisis reply goes first; the decision is still recorded.
      const crisisBubbles = crisis ? await this.finalize(turn, "", true, turnTextOf(texts)) : [];
      if (crisisBubbles.length > 0) await this.sendBubbles(turn, crisisBubbles, chatId, to, 0, generation, epoch);
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
        await this.sendBubbles(turn, bubbles, chatId, to, 0, generation, epoch);
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

    // Only the batch's last message can carry a reaction, judged on its
    // own text alone.
    const last = items[items.length - 1];
    const target: Target | null = last?.messageId ? { messageId: last.messageId, text: last.text ?? "" } : null;
    // The eyes say Mano is on it: at once for a photo, and otherwise when
    // the turn routes deep or runs past eyesAfterMs.
    const eyes = this.eyesFor(turn, chatId, target, crisis, generation, epoch);
    if (attachments.length > 0) eyes.put("attachment");
    // Tracked by the decoration queue, so STOP, a close or a delete cancels it.
    const stopEyesTimer = this.decorations.schedule("eyes_timer", config.eyesAfterMs, () => eyes.put("slow"));

    // Keepalive refreshes run one at a time. Before the final stop, no
    // new refresh starts and the one in flight finishes, so typing can
    // never come back on after Mano is done.
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    let refreshing: Promise<void> = Promise.resolve();
    let typingDone = false;
    let replied = false;
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
          // Every reply has words; an empty one becomes the guard's safe
          // line in finalize. A reaction is only ever added on top: picked
          // by the model from what the target message allows, never on a
          // message that has the eyes, and sent outside the turn.
          const tapback = config.reactionsEnabled && target && !eyes.placed ? allowedTapback(answer.tapback, target.text, crisis) : null;
          const answered = await this.finalize(turn, answer.text, crisis, turnText);
          const replyTo = inlineReplyTarget(items);
          if (replyTo && answered[0]) answered[0] = { ...answered[0], replyTo };
          bubbles.push(...answered);
          if (tapback && target && chatId && answered.length > 0) {
            bubbles.push({ part: 0, tag: "react", text: tapback, messageId: target.messageId, epoch });
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
      await this.sendBubbles(turn, bubbles, chatId, to, saved, generation, epoch);
      this.checkSendsResolved(turn, generation);
      await this.reportPresentations();
      replied = true;
    } finally {
      stopEyesTimer();
      typingDone = true;
      clearInterval(typingTimer);
      await refreshing;
      if (chatId) await this.bestEffort("typing_stopped", () => this.deps.channel.setTyping(chatId, "stopped"));
    }
    // The background is decoration too: started outside the turn once a
    // reply reached the person, so it can never hold the next message.
    if (replied && chatId && !crisis && this.deps.config.backgroundUrl) {
      const sent = this.store.outbounds().some((r) => r.turn === turn && r.state === "sent" && r.tag !== "react");
      if (sent) this.decorations.run("background", (signal) => this.setBackgroundOnce(chatId, generation, epoch, signal));
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
    const stuck = this.store.outbounds().some((r) => r.turn === turn && openSend(r));
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
    epoch: number,
  ): Promise<void> {
    const { store, logger } = this.deps;
    // Bubbles arrive final: model text was sanitized before splitting
    // and capped by the splitter, and the static texts carry no links
    // (pinned by test). Nothing here mutates them, so a replayed turn
    // sends byte-identical bubbles under the same keys.
    let fresh = 0;
    // Whether the provider accepted at least one of the reply's own texts.
    let accepted = false;
    // Words go first; a reaction is only ever added on top.
    for (const bubble of [...bubbles.filter((b) => b.tag !== "react"), ...bubbles.filter((b) => b.tag === "react")]) {
      if (bubble.tag === "react") {
        // Only on top of words the provider accepted, and only while
        // reactions are on (a replayed answer included); otherwise dropped.
        // After the words, and outside the turn: never awaited.
        if (!this.deps.config.reactionsEnabled || !accepted) {
          this.dropTapback(turn, bubble, chatId, generation, this.deps.config.reactionsEnabled ? "no_text_accepted" : "reactions_off");
          continue;
        }
        const planned = bubble.epoch ?? epoch;
        this.decorations.run("reaction", () => this.sendTapback(turn, bubble, chatId, generation, planned));
        continue;
      }
      const row = await this.sendBubble({ turn, part: bubble.part, tag: bubble.tag, text: bubble.text, chatId, to, generation, replyTo: bubble.replyTo ?? null });
      if (row.fresh) fresh += 1;
      if (bubble.tag === "" && bubble.part >= 1 && (row.state === "sent" || row.state === "delivered" || row.state === "read")) accepted = true;
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
  // A reaction is decoration on top of words: it runs outside the turn,
  // never awaited by it, and goes out at most once. Its row is written as
  // "sending" before the call, so a resumed or retried turn never issues
  // it again; an outcome that never comes back leaves it there, dropped.
  // It sends only while the generation and decoration epoch it was
  // scheduled under still hold, read fresh right before the call.
  // Records a reaction as dropped, so no later run sends it.
  private dropTapback(turn: number, bubble: import("./store.js").AnswerBubble, chatId: string | null, generation: number, code: string): void {
    const { store, logger, nowMs, config } = this.deps;
    if (store.meta().generation !== generation) return;
    const key = idempotencyKeyFor(config.handleHash, generation, turn, bubble.part, "react");
    if (store.outboundByKey(key)) return;
    store.addOutbound({
      key, turn, part: bubble.part, tag: "react", text: bubble.text, attempts: 0, state: "refused", code,
      chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
    });
    logger.info("tapback_dropped", { handle: this.logHandle(), turn, code });
  }

  private async sendTapback(turn: number, bubble: import("./store.js").AnswerBubble, chatId: string | null, generation: number, epoch: number): Promise<void> {
    const { store, channel, logger, nowMs, config } = this.deps;
    if (!config.reactionsEnabled) return;
    const block = !chatId || !bubble.messageId ? "unroutable" : this.decorationBlock(generation, epoch);
    if (block === "generation") return;
    const key = idempotencyKeyFor(config.handleHash, generation, turn, bubble.part, "react");
    if (store.outboundByKey(key)) return;
    const row = (state: "sending" | "refused", code: string | null) => ({
      key, turn, part: bubble.part, tag: "react", text: bubble.text, attempts: 0, state, code,
      chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
    });
    if (block) {
      store.addOutbound(row("refused", block));
      logger.info("tapback_suppressed", { handle: this.logHandle(), turn, code: block });
      return;
    }
    store.addOutbound(row("sending", null));
    try {
      await channel.react(chatId!, bubble.messageId!, bubble.text as import("@mano/channels").Tapback);
      if (this.store.meta().generation === generation) store.updateOutbound(key, { state: "sent", updatedAtMs: nowMs() });
      logger.info("tapback_sent", { handle: this.logHandle(), turn, tapback: bubble.text });
    } catch (err) {
      // Never retried: a failed or unknown reaction is dropped.
      if (this.store.meta().generation === generation) store.updateOutbound(key, { state: "failed", code: "tapback_dropped", updatedAtMs: nowMs() });
      logger.warn("tapback_dropped", { handle: this.logHandle(), turn, err: errName(err) });
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
        { texts: [turnText], attachmentCount, history, turnKey: { generation, turn }, receivedAtMs, crisis },
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
      if (!openSend(row)) continue;
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
      // Agent texts carry no reactions, so the epoch is only passed along.
      await this.sendBubbles(turn, bubbles, chatId, to, 0, generation, this.store.meta().decorationEpoch);
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

// The message a turn may react to: the batch's last one.
interface Target {
  messageId: string;
  text: string;
}

// The eyes on one turn's target message.
interface Eyes {
  // Set when the eyes are put on; then no other reaction goes there.
  placed: boolean;
  // Puts them on once, outside the turn, when the message allows them.
  put(why: string): void;
}

// A message send whose outcome is still open. A reaction or the eyes are
// never one: sent at most once, an unknown outcome dropped, not retried.
function openSend(r: import("./store.js").OutboundRow): boolean {
  return !DECORATION_TAGS.has(r.tag) && (r.state === "uncertain" || r.state === "sending");
}

// Rows for reactions and the eyes, never for words.
const DECORATION_TAGS: ReadonlySet<string> = new Set(["react", "eyes"]);
