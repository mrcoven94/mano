// Recording stand-in for Channel. Tests and local runs use it when no
// provider key is configured. It records every send, answers scripted
// events, and replays failures (refusals, timeouts, duplicates) on cue.
import {
  ChannelFailed,
  ChannelRefused,
  ChannelUncertain,
  type Channel,
  type ChannelEventPage,
  type ChannelMessageStatus,
  type ChannelSendInput,
  type ChannelSendResult,
} from "./channel.js";
import { parseBlooioEvent } from "./blooio.js";
import type { NormalizedEvent, Reaction } from "./types.js";

export interface RecordedSend extends ChannelSendInput {
  messageId: string;
  at: number;
}

export type ScriptedFailure =
  | { kind: "refuse"; status: number; code: string }
  | { kind: "fail"; status: number; code: string }
  | { kind: "timeout-then-absent" }
  | { kind: "timeout-then-present"; messageId: string }
  | { kind: "uncertain"; attempts: number };

export class RecordingChannel implements Channel {
  readonly name = "recording";
  sends: RecordedSend[] = [];
  typingCalls: Array<{ chatId: string; state: "started" | "stopped" }> = [];
  readCalls: string[] = [];
  reactions: Array<{ chatId: string; messageId: string; reaction: Reaction }> = [];
  unreactions: Array<{ chatId: string; messageId: string; reaction: Reaction }> = [];
  backgrounds: Array<{ chatId: string; type: string; size: number }> = [];
  // Set to make reactions or background uploads throw, for failure paths.
  failReactions = false;
  // What setBackground does: lands, fails knowingly, ends uncertain, or
  // never settles (until its signal aborts).
  backgroundOutcome: "set" | "failed" | "uncertain" | "hang" = "set";
  // What hasBackground answers per chat, for reconciling.
  devicesWithBackground = new Set<string>();
  backgroundReads: string[] = [];
  backgroundSignals: AbortSignal[] = [];
  lookupCalls: Array<{ chatId: string; messageId: string }> = [];
  // Feed pages served to listEvents, in order.
  feedPages: NormalizedEvent[][] = [];
  // Full events served to hydrateEvent, keyed by message id. A keyed
  // error throws instead, like a transient fetch failure.
  hydrated = new Map<string, NormalizedEvent>();
  hydrateErrors = new Map<string, Error>();
  hydrateCalls: string[] = [];
  // Keyed by idempotency key: the failure the next send with that key gets.
  failures = new Map<string, ScriptedFailure>();
  private seq = 0;
  private sentByKey = new Map<string, ChannelSendResult>();

  parseEvent(raw: unknown): NormalizedEvent | null {
    return parseBlooioEvent(raw);
  }

  scriptFailure(idempotencyKey: string, failure: ScriptedFailure): void {
    this.failures.set(idempotencyKey, failure);
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    const failure = this.failures.get(input.idempotencyKey);
    if (failure?.kind === "refuse") {
      this.failures.delete(input.idempotencyKey);
      throw new ChannelRefused(failure.status, failure.code, `Refused in test: ${failure.code}`);
    }
    if (failure?.kind === "fail") {
      this.failures.delete(input.idempotencyKey);
      throw new ChannelFailed(failure.status, failure.code, `Failed in test: ${failure.code}`);
    }
    if (failure?.kind === "timeout-then-absent") {
      this.failures.delete(input.idempotencyKey);
      throw new ChannelUncertain("Send timed out in test.", 1);
    }
    if (failure?.kind === "timeout-then-present") {
      // The provider sent it but the response was lost: the replayed key
      // returns the stored original, exactly like the live API.
      this.failures.delete(input.idempotencyKey);
      const original: ChannelSendResult = {
        messageId: failure.messageId,
        chatId: input.chatId ?? `chat_${input.to}`,
        duplicate: false,
      };
      this.sentByKey.set(input.idempotencyKey, { ...original, duplicate: true });
      this.sends.push({ ...input, messageId: failure.messageId, at: Date.now() });
      throw new ChannelUncertain("Send timed out in test.", 1);
    }
    if (failure?.kind === "uncertain") {
      this.failures.delete(input.idempotencyKey);
      throw new ChannelUncertain("Send outcome unknown in test.", failure.attempts);
    }
    const prior = this.sentByKey.get(input.idempotencyKey);
    if (prior) return { ...prior, duplicate: true };
    this.seq += 1;
    const result: ChannelSendResult = {
      messageId: `msg_test_${this.seq}`,
      chatId: input.chatId ?? `chat_${input.to}`,
      duplicate: false,
    };
    this.sentByKey.set(input.idempotencyKey, result);
    this.sends.push({ ...input, messageId: result.messageId, at: Date.now() });
    return result;
  }

  async setTyping(chatId: string, state: "started" | "stopped"): Promise<void> {
    this.typingCalls.push({ chatId, state });
  }

  async markRead(chatId: string): Promise<void> {
    this.readCalls.push(chatId);
  }

  async react(chatId: string, messageId: string, reaction: Reaction): Promise<void> {
    if (this.failReactions) throw new Error("reaction failed");
    this.reactions.push({ chatId, messageId, reaction });
  }

  async unreact(chatId: string, messageId: string, reaction: Reaction): Promise<void> {
    if (this.failReactions) throw new Error("reaction failed");
    this.unreactions.push({ chatId, messageId, reaction });
  }

  async setBackground(chatId: string, image: Blob, signal?: AbortSignal): Promise<void> {
    this.backgrounds.push({ chatId, type: image.type, size: image.size });
    if (signal) this.backgroundSignals.push(signal);
    if (this.backgroundOutcome === "failed") throw new ChannelFailed(400, "bad_image", "background failed");
    if (this.backgroundOutcome === "uncertain") throw new ChannelUncertain("background outcome unknown", 1);
    if (this.backgroundOutcome === "hang") {
      await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    this.devicesWithBackground.add(chatId);
  }

  async hasBackground(chatId: string): Promise<boolean> {
    this.backgroundReads.push(chatId);
    return this.devicesWithBackground.has(chatId);
  }

  async lookupMessage(chatId: string, messageId: string): Promise<ChannelMessageStatus | null> {
    this.lookupCalls.push({ chatId, messageId });
    const found = this.sends.find((s) => s.messageId === messageId);
    if (!found) return null;
    return { messageId, chatId: found.chatId ?? chatId, status: "sent", protocol: "imessage", errorCode: null };
  }

  async listEvents(cursor: string | null): Promise<ChannelEventPage> {
    const index = cursor ? Number(cursor) : 0;
    const events = this.feedPages[index] ?? [];
    const nextCursor = index + 1 < this.feedPages.length ? String(index + 1) : null;
    return { events, nextCursor };
  }

  async hydrateEvent(event: NormalizedEvent): Promise<NormalizedEvent | null> {
    if (!event.messageId) return null;
    this.hydrateCalls.push(event.messageId);
    if (this.hydrateErrors.has(event.messageId)) throw this.hydrateErrors.get(event.messageId);
    return this.hydrated.get(event.messageId) ?? null;
  }
}
