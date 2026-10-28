// One conversation's turn runner. Pure orchestration over injected
// dependencies: the store (SQLite in the DO, memory in tests), the
// channel, the responder, files and the spend ledger. Nothing here names
// a provider or a runtime.
import {
  ChannelRefused,
  ChannelUncertain,
  HANDLE_BYTES_DAILY,
  INPUT_SLACK_CHARS,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
  MAX_OUTPUT_CHARS,
  OUTBOUND_RANK,
  ResponderFailed,
  TURN_TEXT_CAP,
  dayKeyFor,
  estimateCostUsd,
  LinkChecker,
  MAX_PENDING_CHARS,
  handleOverLimit,
  hourKeyFor,
  idempotencyKeyFor,
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
import type { Responder } from "@mano/channels";
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
  byteReserve(key: string, bytes: number): Promise<{ allowed: boolean; bytesUsed: number }>;
  byteSettle(key: string, actualBytes: number): Promise<void>;
}

export interface RunnerConfig {
  handleHash: string;
  batchMs: number;
  interimMs: number;
  budgetUsd: number;
  usdPer1kChars: number;
  maxInboundAgeMs: number;
  mediaHosts: string[];
}

export const DEFAULT_MEDIA_HOSTS = ["bucket.blooio.com"];

export const DEFAULT_RUNNER_CONFIG: Omit<RunnerConfig, "handleHash"> = {
  batchMs: 2500,
  interimMs: 20000,
  budgetUsd: 5,
  usdPer1kChars: 0.001,
  maxInboundAgeMs: 5 * 60 * 1000,
  mediaHosts: DEFAULT_MEDIA_HOSTS,
};

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

export type TurnResult = "ran" | "waiting" | "idle" | "running" | "stopped";

// The conversation was deleted mid-turn: the generation moved on. The
// turn stops without writing so it cannot recreate wiped data.
export class GenerationStopped extends Error {
  constructor() {
    super("Conversation generation moved on.");
    this.name = "GenerationStopped";
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

// Out-of-order delivery events resolve by rank, with two guards: failed
// and refused never move again, and a failure never overwrites proof of
// delivery.
export function advanceLifecycle(current: OutboundState, next: OutboundState): OutboundState | null {
  if (current === "failed" || current === "refused") return null;
  if (next === "failed") return current === "delivered" || current === "read" ? null : "failed";
  return OUTBOUND_RANK[next] > OUTBOUND_RANK[current] ? next : null;
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
    if (event.kind === "ignored" || event.kind === "typing.started" || event.kind === "typing.stopped") {
      if (!store.hasEvent(event.id)) store.recordEvent(event.id, event.kind, nowMs());
      return "recorded";
    }
    if (store.hasEvent(event.id)) return "duplicate";
    store.recordEvent(event.id, event.kind, nowMs());

    // Groups are recorded and never answered. A group reply could carry a
    // private answer into a shared chat, so only 1:1 chats reach a turn.
    if (event.group) {
      logger.info("group_skipped", { handle: this.logHandle(), eventId: event.id });
      return "recorded";
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
      if (text && isOptOut(text) && event.attachments.length === 0) {
        return this.applyOptOut(event);
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
      meta.chatId = event.chatId ?? meta.chatId;
      meta.to = event.handle ?? meta.to;
      meta.closed = false;
      meta.optedOut = false;
      meta.lastInboundMs = nowMs();
      store.saveMeta(meta);
      store.addPending({
        eventId: event.id,
        receivedAtMs: nowMs(),
        chatId: event.chatId ?? meta.chatId ?? "",
        to: event.handle ?? meta.to ?? "",
        text: event.text,
        attachments: event.attachments,
        fromReconcile: source === "reconcile",
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

    if (event.kind === "reaction") return "activity";

    if (event.kind === "chat.closed") {
      const meta = store.meta();
      meta.closed = true;
      store.saveMeta(meta);
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
    const meta = store.meta();
    if (meta.optedOut) return "opted-out";
    meta.optedOut = true;
    meta.chatId = event.chatId ?? meta.chatId;
    meta.to = event.handle ?? meta.to;
    meta.turn += 1;
    store.saveMeta(meta);
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
    // Fast path stays synchronous when nothing is uncertain, so the
    // batch decision below sees the same state as the caller.
    if (store.outbounds().some((r) => r.state === "uncertain")) {
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
        throw err;
      }
      return "ran";
    }
    const meta = store.meta();
    if (meta.running) {
      // Stale flag with no turn row behind it: a crash before the first
      // persist. Clear it and proceed; nothing was sent yet.
      meta.running = false;
      store.saveMeta(meta);
    }
    const pending = store.pending();
    if (pending.length === 0) return "idle";
    if (nowMs() - meta.lastInboundMs < this.deps.config.batchMs) return "waiting";
    try {
      await this.runGuarded(async () => {
        for (const items of partitionByChat(pending, store.meta().chatId)) {
          const turnMeta = store.meta();
          turnMeta.turn += 1;
          store.saveMeta(turnMeta);
          const turn = turnMeta.turn;
          const chatId = [...items].reverse().find((i) => i.chatId)?.chatId ?? turnMeta.chatId;
          const to = [...items].reverse().find((i) => i.to)?.to ?? turnMeta.to;
          store.startTurn({
            turn,
            itemsJson: JSON.stringify(items),
            chatId,
            to,
            answerJson: null,
            costUsd: null,
            costSettled: false,
            state: "started",
            createdAtMs: nowMs(),
            updatedAtMs: nowMs(),
          });
          try {
            await this.runTurnBody(turn, items, null, generation);
          } finally {
            this.finishTurnRow(turn, items);
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
    return "ran";
  }

  private checkGeneration(generation: number): void {
    if (this.store.meta().generation !== generation) throw new GenerationStopped();
  }

  private active = false;

  private async runGuarded(fn: () => Promise<void>): Promise<void> {
    const { store } = this.deps;
    const meta = store.meta();
    meta.running = true;
    store.saveMeta(meta);
    try {
      await fn();
    } finally {
      const done = store.meta();
      done.running = false;
      store.saveMeta(done);
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
      return;
    }
    const texts = items.map((i) => i.text).filter((t): t is string => !!t && t.length > 0);
    const attachments = items.flatMap((i) => i.attachments);

    const approval = texts.length === 1 && attachments.length === 0 ? parseApprovalReply(texts[0]) : null;
    if (approval && store.pendingApprovals(nowMs()).length > 0) {
      const answered = await this.answerApproval(approval.code, approval.decision, turn, chatId, to);
      if (answered) {
        store.updateTurnAnswer(turn, JSON.stringify([{ part: 1, tag: "", text: APPROVAL_RECORDED_BUBBLE }]), 0, nowMs());
        store.markTurnSettled(turn, nowMs());
        return;
      }
    }

    const over = handleOverLimit(
      { hourKey: meta.hourKey, hourCount: meta.hourCount, dayKey: meta.dayKey, dayCount: meta.dayCount },
      nowMs(),
    );
    const turnText = texts.join("\n").slice(0, TURN_TEXT_CAP);
    const reserveKey = `${config.handleHash}:${turn}`;
    const worstUsd = estimateCostUsd(
      (turnText.length + INPUT_SLACK_CHARS) * this.deps.responder.maxAttempts,
      MAX_OUTPUT_CHARS,
      config.usdPer1kChars,
    );
    const budgeted = over ? { allowed: false, spentUsd: 0 } : await this.deps.spend.reserve(reserveKey, worstUsd);
    if (over || !budgeted.allowed) {
      logger.info("turn_limited", {
        handle: this.logHandle(),
        turn,
        reason: over ?? "budget",
        spentUsd: budgeted.spentUsd,
      });
      const noticed = await this.sendBusyOnce(turn, chatId, to, over ?? "budget", nowMs());
      store.updateTurnAnswer(turn, JSON.stringify(noticed ? [{ part: 0, tag: "busy", text: BUSY_BUBBLE }] : []), 0, nowMs());
      store.markTurnSettled(turn, nowMs());
      // Over a limit nothing is downloaded: admission failed, so the
      // turn's attachments are dropped with the turn.
      if (attachments.length > 0) {
        logger.info("attachments_dropped", { handle: this.logHandle(), turn, count: attachments.length });
      }
      return;
    }

    if (chatId) {
      await this.bestEffort("mark_read", () => this.deps.channel.markRead(chatId));
      await this.bestEffort("typing_started", () => this.deps.channel.setTyping(chatId, "started"));
    }
    try {
      const saved = await this.saveAttachments(turn, attachments);
      const bubbles: import("./store.js").AnswerBubble[] = [];
      if (!meta.introduced) bubbles.push({ part: 0, tag: "", text: INTRO_BUBBLE });
      if (saved > 0) bubbles.push({ part: 0, tag: "ack", text: attachmentAck(saved) });
      if (turnText) {
        this.checkGeneration(generation);
        const answer = await this.respondWithInterim(turn, turnText, saved, chatId, to, generation);
        if (answer.ok) {
          answer.bubbles.forEach((text, i) => bubbles.push({ part: i + 1, tag: "", text }));
          store.updateTurnAnswer(turn, JSON.stringify(bubbles), answer.costUsd, nowMs());
          await this.deps.spend.settle(reserveKey, answer.costUsd);
          store.markTurnSettled(turn, nowMs());
        } else {
          bubbles.push({ part: 1, tag: "", text: FAILURE_BUBBLE });
          store.updateTurnAnswer(turn, JSON.stringify(bubbles), answer.costUsd, nowMs());
          await this.deps.spend.settle(reserveKey, answer.costUsd);
          store.markTurnSettled(turn, nowMs());
        }
      } else {
        store.updateTurnAnswer(turn, JSON.stringify(bubbles), 0, nowMs());
        store.markTurnSettled(turn, nowMs());
      }
      this.checkGeneration(generation);
      await this.sendBubbles(turn, bubbles, chatId, to, saved, generation);
    } finally {
      if (chatId) await this.bestEffort("typing_stopped", () => this.deps.channel.setTyping(chatId, "stopped"));
    }
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
    const { store, logger, fetchFn } = this.deps;
    const checker = new LinkChecker({ fetchFn });
    let fresh = 0;
    for (const bubble of bubbles) {
      const cleaned = await stripBlockedLinks(bubble.text, checker);
      if (cleaned.removed > 0) {
        logger.warn("reply_links_removed", { handle: this.logHandle(), turn, removed: cleaned.removed });
      }
      const row = await this.sendBubble({ turn, part: bubble.part, tag: bubble.tag, text: cleaned.text, chatId, to, generation });
      if (row.fresh) fresh += 1;
      if (bubble.tag === "" && bubble.part === 0 && row.state === "sent") {
        const introduced = store.meta();
        introduced.introduced = true;
        store.saveMeta(introduced);
      }
    }
    // Limits count inside the one send path; the turn only reports.
    logger.info("turn_ran", { handle: this.logHandle(), turn, bubbles: bubbles.length, sent: fresh, saved });
  }

  private async respondWithInterim(
    turn: number,
    turnText: string,
    attachmentCount: number,
    chatId: string | null,
    to: string | null,
    generation: number,
  ): Promise<{ ok: true; bubbles: string[]; costUsd: number } | { ok: false; costUsd: number }> {
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
        .catch((err: unknown) => logger.warn("interim_failed", { handle: this.logHandle(), turn, err: String(err) }));
    }, config.interimMs);
    const attemptCost = (inputChars: number, attempts: number): number =>
      estimateCostUsd(inputChars * attempts, 0, config.usdPer1kChars);
    try {
      const result = await responder.respond({ texts: [turnText], attachmentCount });
      const costUsd =
        result.model === "stand-in" ? 0 : estimateCostUsd(result.inputChars * result.attempts, result.outputChars, config.usdPer1kChars);
      return { ok: true, bubbles: result.bubbles, costUsd };
    } catch (err) {
      logger.warn("responder_failed", { handle: this.logHandle(), turn, err: err instanceof Error ? err.message : "unknown" });
      const costUsd = err instanceof ResponderFailed ? attemptCost(err.inputChars, err.attempts) : 0;
      return { ok: false, costUsd };
    } finally {
      done = true;
      clearTimeout(timer);
    }
  }

  private async sendBusyOnce(
    turn: number,
    chatId: string | null,
    to: string | null,
    reason: string,
    nowMs: number,
  ): Promise<boolean> {
    const meta = this.store.meta();
    const key = reason === "hour" ? `hour:${hourKeyFor(nowMs)}` : reason === "day" ? `day:${dayKeyFor(nowMs)}` : `budget:${dayKeyFor(nowMs)}`;
    if (meta.busyNoticeKey === key) return false;
    meta.busyNoticeKey = key;
    this.store.saveMeta(meta);
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
          await spend.byteSettle(byteKey, 0);
          logger.warn("attachment_refused", { handle: this.logHandle(), turn, reason: fetched.reason });
          continue;
        }
        const bytes = fetched.bytes;
        const documentId = await attachmentDocumentId(turn, saved, attachment.url);
        await saveAttachment(files, kekB64, config.handleHash, documentId, bytes);
        await spend.byteSettle(byteKey, bytes.byteLength);
        const counted = store.meta();
        counted.byteDayCount = (counted.byteDayKey === byteDay ? counted.byteDayCount : 0) + bytes.byteLength;
        counted.byteDayKey = byteDay;
        store.saveMeta(counted);
        saved += 1;
      } catch (err) {
        await spend.byteSettle(byteKey, 0);
        logger.warn("attachment_failed", { handle: this.logHandle(), turn, err: err instanceof Error ? err.message : "unknown" });
      }
    }
    return saved;
  }

  // The one send path. Every bubble goes through here with its
  // deterministic key. A send whose outcome is unknown is marked
  // uncertain, never failed: the worker looks the message up (or replays
  // its key, which the provider answers from its stored original) before
  // deciding, retrying on later alarms until it knows.
  async sendBubble(opts: {
    turn: number;
    part: number;
    tag: string;
    text: string;
    chatId: string | null;
    to: string | null;
    force?: boolean;
    generation?: number;
  }): Promise<SendBubbleResult> {
    const { store, channel, logger, nowMs, config } = this.deps;
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
          key, turn: opts.turn, part: opts.part, tag: opts.tag, text: opts.text, state: "refused", code,
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
        key, turn: opts.turn, part: opts.part, tag: opts.tag, text: opts.text, state: "planned", code: null,
        chatId: opts.chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
      });
    }
    store.updateOutbound(key, { state: "sending", updatedAtMs: nowMs() });
    try {
      const result = await channel.send({ to: opts.to ?? "", chatId: opts.chatId, text: opts.text, idempotencyKey: key });
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
      if (err instanceof ChannelUncertain) {
        store.updateOutbound(key, { state: "uncertain", updatedAtMs: nowMs() });
        logger.warn("send_uncertain", { handle: this.logHandle(), key });
        return this.resolveUncertainKey(key, opts, generation);
      }
      store.updateOutbound(key, { state: "failed", code: "send_error", updatedAtMs: nowMs() });
      logger.warn("send_failed", { handle: this.logHandle(), key, code: "send_error" });
      return finish({ key, state: "failed", code: "send_error", fresh: false, counted: false });
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
        logger.warn("lookup_failed", { handle: this.logHandle(), key, err: err instanceof Error ? err.message : "unknown" });
      }
    }
    try {
      const result = await channel.send({ to: opts.to ?? "", chatId: opts.chatId, text: opts.text, idempotencyKey: key });
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
      store.updateOutbound(key, { state: "uncertain", updatedAtMs: nowMs() });
      logger.warn("send_still_uncertain", { handle: this.logHandle(), key });
      return finish({ key, state: "uncertain", code: null, fresh: false, counted: false });
    }
  }

  // Retries every uncertain send with its stored text. Runs on each
  // alarm tick before turns, so an uncertain send resolves as soon as
  // the provider answers again.
  async resolveUncertain(): Promise<number> {
    const generation = this.store.meta().generation;
    let resolved = 0;
    for (const row of this.store.outbounds()) {
      if (row.state !== "uncertain") continue;
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
    meta.hourCount = meta.hourKey === hourKey ? meta.hourCount + sent : sent;
    meta.dayCount = meta.dayKey === dayKey ? meta.dayCount + sent : sent;
    meta.hourKey = hourKey;
    meta.dayKey = dayKey;
    this.store.saveMeta(meta);
  }

  private async bestEffort(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.logger.warn(name, { handle: this.logHandle(), err: err instanceof Error ? err.message : "unknown" });
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

  private async answerApproval(
    code: string,
    decision: "yes" | "no",
    turn: number,
    chatId: string | null,
    to: string | null,
  ): Promise<boolean> {
    const { store, logger, nowMs } = this.deps;
    const codeHash = await sha256Hex(code);
    const match = store.pendingApprovals(nowMs()).find((a) => a.codeHash === codeHash);
    if (!match) return false;
    store.answerApproval(match.id, decision);
    logger.info("approval_answered", { handle: this.logHandle(), approval: match.id, decision });
    await this.sendBubble({ turn, part: 1, tag: "", text: APPROVAL_RECORDED_BUBBLE, chatId, to });
    return true;
  }
}
