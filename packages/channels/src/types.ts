// Shared shapes for every messaging channel. Providers are normalized to
// these before anything else sees them, so SMS and email fit later without
// changing the worker.

export type EventDirection = "inbound" | "outbound";

export type NormalizedEventKind =
  | "message.received"
  | "message.sent"
  | "message.delivered"
  | "message.read"
  | "message.failed"
  | "typing.started"
  | "typing.stopped"
  | "chat.closed"
  | "reaction"
  | "ignored";

export interface EventAttachment {
  url: string;
  mediaType?: string;
  size?: number;
  name?: string;
}

export interface EventGroup {
  id: string;
  name: string | null;
}

import type { Tapback } from "@mano/persona";
export type { Tapback };

export interface NormalizedEvent {
  id: string;
  kind: NormalizedEventKind;
  rawType: string;
  channelId: string | null;
  channelType: string | null;
  // Our own line's address on this event (number or alias), when the
  // provider includes it. Ingress checks it against MANO_TEXT_NUMBER.
  channelAddress: string | null;
  chatId: string | null;
  messageId: string | null;
  // Set when the event belongs to a group chat. The worker records group
  // events and answers 1:1 chats only, so a private reply can never land
  // in a group.
  group: EventGroup | null;
  // The other party's handle (phone or email), normalized. Null when the
  // event is not about one handle.
  handle: string | null;
  direction: EventDirection | null;
  text: string | null;
  attachments: EventAttachment[];
  // On a reaction event: the tapback and whether it was added or removed.
  // messageId is the message it sits on.
  reaction?: { value: string; action: "add" | "remove" } | null;
  // Machine-readable provider code on failures and refusals.
  errorCode: string | null;
  errorMessage: string | null;
  // Null when the provider gave no usable timestamp. The worker never
  // treats an undated event as new: undated inbound is quarantined, and
  // undated events older than a deletion cutoff are dropped.
  occurredAtMs: number | null;
}

export type OutboundState =
  | "planned"
  | "sending"
  // The send may or may not have landed: timeout, network error, or 5xx
  // after retries. Never terminal: the worker looks the message up (or
  // replays its idempotency key) before deciding.
  | "uncertain"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "refused";

export const OUTBOUND_RANK: Record<OutboundState, number> = {
  planned: 0,
  sending: 1,
  uncertain: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  refused: 7,
};

// The lifecycle state a delivery event carries, or null when the event
// kind says nothing about a send.
export function lifecycleStateFor(kind: NormalizedEventKind): OutboundState | null {
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

export interface ChannelSendInput {
  to: string;
  chatId: string | null;
  text: string;
  idempotencyKey: string;
  // The inbound message this bubble answers, shown as an inline reply.
  replyTo?: string | null;
}

export interface ChannelSendResult {
  messageId: string;
  chatId: string;
  // True when the provider returned its stored original for a replayed
  // idempotency key instead of sending again.
  duplicate: boolean;
}

export interface ChannelMessageStatus {
  messageId: string;
  chatId: string;
  status: string;
  protocol: string | null;
  errorCode: string | null;
}

export interface ChannelEventPage {
  events: NormalizedEvent[];
  nextCursor: string | null;
}
