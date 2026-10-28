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

export interface NormalizedEvent {
  id: string;
  kind: NormalizedEventKind;
  rawType: string;
  channelId: string | null;
  channelType: string | null;
  chatId: string | null;
  messageId: string | null;
  // The other party's handle (phone or email), normalized. Null when the
  // event is not about one handle.
  handle: string | null;
  direction: EventDirection | null;
  text: string | null;
  attachments: EventAttachment[];
  // Machine-readable provider code on failures and refusals.
  errorCode: string | null;
  errorMessage: string | null;
  occurredAtMs: number;
}

export type OutboundState =
  | "planned"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "refused";

export const OUTBOUND_RANK: Record<OutboundState, number> = {
  planned: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
  refused: 6,
};

export interface ChannelSendInput {
  to: string;
  chatId: string | null;
  text: string;
  idempotencyKey: string;
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
