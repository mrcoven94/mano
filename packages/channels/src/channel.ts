// The one interface every messaging provider implements. The worker only
// talks to a Channel, so SMS providers and email fit later without
// changing the turn runner or the send path.
import type {
  ChannelEventPage,
  ChannelMessageStatus,
  ChannelSendInput,
  ChannelSendResult,
  NormalizedEvent,
} from "./types.js";

export interface Channel {
  readonly name: string;
  // Returns null for payloads that are not channel events.
  parseEvent(raw: unknown): NormalizedEvent | null;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
  setTyping(chatId: string, state: "started" | "stopped"): Promise<void>;
  markRead(chatId: string): Promise<void>;
  // Null when the provider has no record of the message.
  lookupMessage(chatId: string, messageId: string): Promise<ChannelMessageStatus | null>;
  listEvents(cursor: string | null, limit: number): Promise<ChannelEventPage>;
  // Fills a thin feed item (no text or sender) into a full event by
  // fetching its message. Null when there is nothing to fetch (not an
  // inbound message, or the message is gone and retrying is pointless).
  // Throws when the fetch fails transiently so the caller retries later.
  hydrateEvent(event: NormalizedEvent): Promise<NormalizedEvent | null>;
}

// A refusal from the provider (opt-out, conversation limit, safety,
// closed chat). Record it and stop; never retry on a timer.
export class ChannelRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ChannelRefused";
    this.status = status;
    this.code = code;
  }
}

// A send the provider definitively rejected with a client error other
// than a refusal (unknown chat, bad body): it did not land, so the
// caller records it failed instead of retrying forever.
export class ChannelFailed extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ChannelFailed";
    this.status = status;
    this.code = code;
  }
}

// A send whose outcome is unknown: timeout, network error, or 5xx after
// retries. The caller must look the message up before trying again.
export class ChannelUncertain extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "ChannelUncertain";
    this.attempts = attempts;
  }
}

export type { ChannelEventPage, ChannelMessageStatus, ChannelSendInput, ChannelSendResult, NormalizedEvent };
