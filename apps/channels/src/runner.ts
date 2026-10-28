// One conversation's turn runner. Pure orchestration over injected
// dependencies: the store (SQLite in the DO, memory in tests), the
// channel, the responder, files and the spend ledger. Nothing here names
// a provider or a runtime.
import {
  ChannelRefused,
  ChannelUncertain,
  MAX_ATTACHMENTS_PER_TURN,
  OUTBOUND_RANK,
  TURN_TEXT_CAP,
  dayKeyFor,
  estimateCostUsd,
  handleOverLimit,
  hourKeyFor,
  idempotencyKeyFor,
  isOptOut,
  parseApprovalReply,
  sha256Hex,
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
import { attachmentDocumentId, downloadBounded, saveAttachment, type FileStore } from "./files.js";

export interface SpendLedger {
  check(estimateUsd: number): Promise<{ allowed: boolean; spentUsd: number }>;
  record(usd: number): Promise<void>;
}

export interface RunnerConfig {
  handleHash: string;
  batchMs: number;
  interimMs: number;
  budgetUsd: number;
  usdPer1kChars: number;
  maxInboundAgeMs: number;
}

export const DEFAULT_RUNNER_CONFIG: Omit<RunnerConfig, "handleHash"> = {
  batchMs: 2500,
  interimMs: 20000,
  budgetUsd: 5,
  usdPer1kChars: 0.001,
  maxInboundAgeMs: 5 * 60 * 1000,
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
  | "activity"
  | "opted-out";

export type TurnResult = "ran" | "waiting" | "idle" | "running";

const TERMINAL_SEND: ReadonlySet<OutboundState> = new Set(["sent", "delivered", "read", "failed", "refused"]);

function lifecycleState(kind: NormalizedEvent["kind"]): OutboundState | null {
  switch (kind) {
    case "message.sent":
      return "sent";
    case "message.delivered":
      return "delivered";
    case "message.read":
      return "read";
    case "message.failed":
      return "failed";
    default:
      return null;
  }
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

    if (event.kind === "message.received" && event.direction === "inbound") {
      const ageMs = event.occurredAtMs > 0 ? nowMs() - event.occurredAtMs : 0;
      if (ageMs > config.maxInboundAgeMs) {
        logger.info("inbound_stale", { handle: this.logHandle(), event: event.id, ageMs });
        return "stale";
      }
      if (!event.chatId && !event.handle) {
        logger.warn("inbound_unroutable", { handle: this.logHandle(), event: event.id });
        return "recorded";
      }
      const text = event.text ?? "";
      if (text && isOptOut(text) && event.attachments.length === 0) {
        return this.applyOptOut(event);
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
        event: event.id,
        source,
        hasText: text.length > 0,
        attachments: event.attachments.length,
      });
      return "queued";
    }

    const lifecycle = lifecycleState(event.kind);
    if (lifecycle && event.messageId) {
      const row = store.outboundByMessageId(event.messageId);
      const advanced = row ? advanceLifecycle(row.state, lifecycle) : null;
      if (row && advanced) {
        store.updateOutbound(row.key, {
          state: advanced,
          code: advanced === "failed" ? (event.errorCode ?? "delivery_failed") : row.code,
          updatedAtMs: nowMs(),
        });
        logger.info("outbound_lifecycle", {
          handle: this.logHandle(),
          event: event.id,
          key: row.key,
          state: advanced,
          code: event.errorCode ?? null,
        });
      }
      return "recorded";
    }

    if (event.kind === "reaction") return "activity";

    if (event.kind === "chat.closed") {
      const meta = store.meta();
      meta.closed = true;
      store.saveMeta(meta);
      logger.info("conversation_closed", { handle: this.logHandle(), event: event.id });
      return "recorded";
    }

    return "recorded";
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
    logger.info("opted_out", { handle: this.logHandle(), event: event.id, turn: meta.turn });
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
  async runDueTurn(): Promise<TurnResult> {
    const { store, nowMs } = this.deps;
    const meta = store.meta();
    if (meta.running) return "running";
    const pending = store.pending();
    if (pending.length === 0) return "idle";
    if (nowMs() - meta.lastInboundMs < this.deps.config.batchMs) return "waiting";
    meta.running = true;
    store.saveMeta(meta);
    try {
      await this.runTurn(pending.map((p) => p.eventId));
    } finally {
      const done = store.meta();
      done.running = false;
      store.saveMeta(done);
    }
    return "ran";
  }

  private async runTurn(eventIds: string[]): Promise<void> {
    const { store, logger, nowMs, config } = this.deps;
    const items = store.pending().filter((p) => eventIds.includes(p.eventId));
    store.clearPending(eventIds);
    const meta = store.meta();
    meta.turn += 1;
    store.saveMeta(meta);
    const turn = meta.turn;
    const chatId = [...items].reverse().find((i) => i.chatId)?.chatId ?? meta.chatId;
    const to = [...items].reverse().find((i) => i.to)?.to ?? meta.to;
    if (!chatId && !to) {
      logger.warn("turn_unroutable", { handle: this.logHandle(), turn });
      return;
    }
    const texts = items.map((i) => i.text).filter((t): t is string => !!t && t.length > 0);
    const attachments = items.flatMap((i) => i.attachments);

    const approval = texts.length === 1 && attachments.length === 0 ? parseApprovalReply(texts[0]) : null;
    if (approval && (await this.answerApproval(approval.code, approval.decision, turn, chatId, to))) return;

    const over = handleOverLimit(
      { hourKey: meta.hourKey, hourCount: meta.hourCount, dayKey: meta.dayKey, dayCount: meta.dayCount },
      nowMs(),
    );
    const turnText = texts.join("\n").slice(0, TURN_TEXT_CAP);
    const estimateUsd = estimateCostUsd(turnText.length, 500, config.usdPer1kChars);
    const budgeted = over ? { allowed: false, spentUsd: 0 } : await this.deps.spend.check(estimateUsd);
    if (over || !budgeted.allowed) {
      logger.info("turn_limited", {
        handle: this.logHandle(),
        turn,
        reason: over ?? "budget",
        spentUsd: budgeted.spentUsd,
      });
      await this.sendBusyOnce(turn, chatId, to, over ?? "budget", nowMs());
      await this.saveAttachmentsQuietly(turn, attachments);
      return;
    }

    if (chatId) {
      await this.bestEffort("mark_read", () => this.deps.channel.markRead(chatId));
      await this.bestEffort("typing_started", () => this.deps.channel.setTyping(chatId, "started"));
    }
    try {
      const saved = await this.saveAttachments(turn, attachments);
      const bubbles: Array<{ part: number; tag: string; text: string }> = [];
      if (!meta.introduced) bubbles.push({ part: 0, tag: "", text: INTRO_BUBBLE });
      if (saved > 0) bubbles.push({ part: 0, tag: "ack", text: attachmentAck(saved) });
      if (turnText) {
        const answer = await this.respondWithInterim(turn, turnText, saved, chatId, to);
        if (answer) {
          answer.bubbles.forEach((text, i) => bubbles.push({ part: i + 1, tag: "", text }));
          await this.deps.spend.record(answer.costUsd);
        } else {
          bubbles.push({ part: 1, tag: "", text: FAILURE_BUBBLE });
        }
      }
      let sent = 0;
      for (const bubble of bubbles) {
        const row = await this.sendBubble({ turn, part: bubble.part, tag: bubble.tag, text: bubble.text, chatId, to });
        if (row.state === "sent") sent += 1;
        if (bubble.tag === "" && bubble.part === 0 && row.state === "sent") {
          const introduced = store.meta();
          introduced.introduced = true;
          store.saveMeta(introduced);
        }
      }
      this.countSent(sent, nowMs());
      logger.info("turn_ran", { handle: this.logHandle(), turn, bubbles: bubbles.length, sent, saved });
    } finally {
      if (chatId) await this.bestEffort("typing_stopped", () => this.deps.channel.setTyping(chatId, "stopped"));
    }
  }

  private async respondWithInterim(
    turn: number,
    turnText: string,
    attachmentCount: number,
    chatId: string | null,
    to: string | null,
  ): Promise<{ bubbles: string[]; costUsd: number } | null> {
    const { responder, config, logger } = this.deps;
    let done = false;
    let interimSent = false;
    const timer = setTimeout(() => {
      if (done || interimSent) return;
      interimSent = true;
      void this
        .sendBubble({ turn, part: 0, tag: "interim", text: INTERIM_BUBBLE, chatId, to })
        .catch((err: unknown) => logger.warn("interim_failed", { handle: this.logHandle(), turn, err: String(err) }));
    }, config.interimMs);
    try {
      const result = await responder.respond({ texts: [turnText], attachmentCount });
      const costUsd = result.model === "stand-in" ? 0 : estimateCostUsd(result.inputChars, result.outputChars, config.usdPer1kChars);
      return { bubbles: result.bubbles, costUsd };
    } catch (err) {
      logger.warn("responder_failed", { handle: this.logHandle(), turn, err: err instanceof Error ? err.message : "unknown" });
      return null;
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
  ): Promise<void> {
    const meta = this.store.meta();
    const key = reason === "hour" ? `hour:${hourKeyFor(nowMs)}` : reason === "day" ? `day:${dayKeyFor(nowMs)}` : `budget:${dayKeyFor(nowMs)}`;
    if (meta.busyNoticeKey === key) return;
    meta.busyNoticeKey = key;
    this.store.saveMeta(meta);
    await this.sendBubble({ turn, part: 0, tag: "busy", text: BUSY_BUBBLE, chatId, to });
  }

  private async saveAttachmentsQuietly(turn: number, attachments: import("@mano/channels").EventAttachment[]): Promise<number> {
    try {
      return await this.saveAttachments(turn, attachments);
    } catch {
      return 0;
    }
  }

  private async saveAttachments(turn: number, attachments: import("@mano/channels").EventAttachment[]): Promise<number> {
    const { files, kekB64, fetchFn, config, logger } = this.deps;
    if (attachments.length === 0) return 0;
    if (!files || !kekB64) {
      logger.warn("attachments_unsaved", { handle: this.logHandle(), turn, reason: "no_storage" });
      return 0;
    }
    let saved = 0;
    for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_TURN)) {
      try {
        const bytes = await downloadBounded(attachment, fetchFn);
        if (!bytes) continue;
        const documentId = await attachmentDocumentId(turn, saved, attachment.url);
        await saveAttachment(files, kekB64, config.handleHash, documentId, bytes);
        saved += 1;
      } catch (err) {
        logger.warn("attachment_failed", { handle: this.logHandle(), turn, err: err instanceof Error ? err.message : "unknown" });
      }
    }
    return saved;
  }

  // The one send path. Every bubble goes through here with its
  // deterministic key. A timeout never resends blind: the same key and
  // body are replayed once, which the provider answers from its stored
  // original instead of sending again.
  async sendBubble(opts: {
    turn: number;
    part: number;
    tag: string;
    text: string;
    chatId: string | null;
    to: string | null;
    force?: boolean;
  }): Promise<{ key: string; state: import("@mano/channels").OutboundState; code: string | null }> {
    const { store, channel, logger, nowMs, config } = this.deps;
    const key = idempotencyKeyFor(config.handleHash, opts.turn, opts.part, opts.tag);
    const prior = store.outboundByKey(key);
    if (prior && (TERMINAL_SEND.has(prior.state) || prior.state === "sending")) {
      if (prior.state !== "sending") return { key, state: prior.state, code: prior.code };
      return this.replayAfterUncertain(key, opts, prior);
    }
    const meta = store.meta();
    if (!opts.force && (meta.closed || meta.optedOut)) {
      const code = meta.closed ? "conversation_closed" : "opted_out";
      if (!prior) {
        store.addOutbound({
          key, turn: opts.turn, part: opts.part, tag: opts.tag, state: "refused", code,
          chatId: opts.chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
        });
      } else {
        store.updateOutbound(key, { state: "refused", code, updatedAtMs: nowMs() });
      }
      logger.info("send_suppressed", { handle: this.logHandle(), key, code });
      return { key, state: "refused", code };
    }
    if (!prior) {
      store.addOutbound({
        key, turn: opts.turn, part: opts.part, tag: opts.tag, state: "planned", code: null,
        chatId: opts.chatId, messageId: null, createdAtMs: nowMs(), updatedAtMs: nowMs(),
      });
    }
    store.updateOutbound(key, { state: "sending", updatedAtMs: nowMs() });
    try {
      const result = await channel.send({ to: opts.to ?? "", chatId: opts.chatId, text: opts.text, idempotencyKey: key });
      store.updateOutbound(key, {
        state: "sent", messageId: result.messageId, chatId: result.chatId, updatedAtMs: nowMs(),
      });
      logger.info("send_sent", { handle: this.logHandle(), key, message: result.messageId, duplicate: result.duplicate });
      return { key, state: "sent", code: null };
    } catch (err) {
      if (err instanceof ChannelRefused) {
        store.updateOutbound(key, { state: "refused", code: err.code, updatedAtMs: nowMs() });
        logger.warn("send_refused", { handle: this.logHandle(), key, code: err.code, status: err.status });
        return { key, state: "refused", code: err.code };
      }
      if (err instanceof ChannelUncertain) {
        return this.replayAfterUncertain(key, opts, null);
      }
      store.updateOutbound(key, { state: "failed", code: "send_error", updatedAtMs: nowMs() });
      logger.warn("send_failed", { handle: this.logHandle(), key, code: "send_error" });
      return { key, state: "failed", code: "send_error" };
    }
  }

  private async replayAfterUncertain(
    key: string,
    opts: { turn: number; part: number; tag: string; text: string; chatId: string | null; to: string | null },
    prior: import("./store.js").OutboundRow | null,
  ): Promise<{ key: string; state: import("@mano/channels").OutboundState; code: string | null }> {
    const { store, channel, logger, nowMs } = this.deps;
    if (!prior) {
      logger.warn("send_uncertain", { handle: this.logHandle(), key });
    } else {
      logger.warn("send_retry_stuck", { handle: this.logHandle(), key });
    }
    try {
      const result = await channel.send({ to: opts.to ?? "", chatId: opts.chatId, text: opts.text, idempotencyKey: key });
      store.updateOutbound(key, {
        state: "sent", messageId: result.messageId, chatId: result.chatId, updatedAtMs: nowMs(),
      });
      logger.info("send_reconciled", { handle: this.logHandle(), key, message: result.messageId, duplicate: result.duplicate });
      return { key, state: "sent", code: null };
    } catch (err) {
      if (err instanceof ChannelRefused) {
        store.updateOutbound(key, { state: "refused", code: err.code, updatedAtMs: nowMs() });
        return { key, state: "refused", code: err.code };
      }
      store.updateOutbound(key, { state: "failed", code: "send_uncertain", updatedAtMs: nowMs() });
      logger.warn("send_uncertain_failed", { handle: this.logHandle(), key });
      return { key, state: "failed", code: "send_uncertain" };
    }
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
