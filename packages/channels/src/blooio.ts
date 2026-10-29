// Blooio v4 implementation of Channel. Every endpoint, field name and
// event shape here was checked against https://docs.blooio.com/llms-full.txt
// and a live call. Base URL https://api.blooio.com/v4, Bearer auth.
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
import { normalizeHandle } from "./handles.js";
import { boundFetch } from "./fetch.js";
import type { EventAttachment, NormalizedEvent, NormalizedEventKind } from "./types.js";

export const BLOOIO_BASE_URL = "https://api.blooio.com/v4";
export const BLOOIO_WEBHOOK_API_VERSION = "2026-10-01";

const SEND_TIMEOUT_MS = 15000;
const SEND_MAX_ATTEMPTS = 3;

export interface BlooioOptions {
  apiKey: string;
  channelId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asMs(v: unknown): number | null {
  if (typeof v === "string" && v.length > 0 && v.length <= 40) {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v < 1_000_000_000_000 ? v * 1000 : v;
}

function kindFor(type: string): NormalizedEventKind {
  switch (type) {
    case "message.received":
    case "message.sent":
    case "message.delivered":
    case "message.read":
    case "message.failed":
    case "typing.started":
    case "typing.stopped":
    case "chat.closed":
      return type;
    default:
      return type.includes("reaction") ? "reaction" : "ignored";
  }
}

function parseAttachments(v: unknown): EventAttachment[] {
  if (!Array.isArray(v)) return [];
  const out: EventAttachment[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const url = asString(item.url);
    if (!url) continue;
    out.push({
      url,
      mediaType: asString(item.media_type) ?? asString(item.mediaType) ?? undefined,
      size: typeof item.size === "number" ? item.size : undefined,
      name: asString(item.name) ?? undefined,
    });
  }
  return out;
}

// Accepts both the webhook envelope
// ({id, type, created_at, data: {message_id, chat_id, channel_id, ...}})
// and the GET /events feed shape
// ({id, type, occurred_at, message_id?, chat_id?, data: {...}}).
export function parseBlooioEvent(raw: unknown): NormalizedEvent | null {
  if (!isRecord(raw)) return null;
  const type = asString(raw.type);
  if (!type) return null;
  const data = isRecord(raw.data) ? raw.data : {};
  const messageId = asString(data.message_id) ?? asString(raw.message_id) ?? asString(data.id);
  // The 2026-10-01 webhook envelope carries no top-level id. The type
  // plus message id is stable across redelivery, so it dedupes the same.
  const id = asString(raw.id) ?? (messageId ? `${type}:${messageId}` : null);
  if (!id) return null;

  const chatId = asString(data.chat_id) ?? asString(raw.chat_id);
  const channelId = asString(data.channel_id) ?? asString(raw.channel_id);
  const channelType = asString(data.channel_type) ?? asString(raw.channel_type);
  const channelAddress = asString(data.channel_address);
  const directionRaw = asString(data.direction);
  // message.received is inbound by definition; the 2026-10-01 envelope
  // omits direction, and without this the handle would resolve to our
  // own line instead of the sender.
  const direction =
    directionRaw === "inbound" || directionRaw === "outbound"
      ? directionRaw
      : type === "message.received"
        ? "inbound"
        : null;
  const kind = kindFor(type);

  const contact = isRecord(data.contact) ? data.contact : null;
  const groupRaw = isRecord(data.group) ? data.group : null;
  const groupId = asString(groupRaw?.group_id);
  const group = groupId ? { id: groupId, name: asString(groupRaw?.name) } : null;
  const rawHandle =
    direction === "inbound"
      ? (asString(data.sender) ?? asString(contact?.identifier))
      : (asString(data.recipient) ?? asString(contact?.identifier));
  const handle = rawHandle ? normalizeHandle(rawHandle) : null;

  const error = isRecord(data.error) ? data.error : null;
  const occurredAtMs =
    asMs(data.occurred_at) ?? asMs(raw.occurred_at) ?? asMs(data.created_at) ?? asMs(raw.created_at);

  return {
    id,
    kind,
    rawType: type,
    channelId,
    channelType,
    channelAddress,
    chatId,
    messageId,
    group,
    handle,
    direction,
    text: typeof data.text === "string" ? data.text : null,
    attachments: parseAttachments(data.attachments),
    errorCode: asString(error?.code),
    errorMessage: typeof error?.message === "string" ? (error.message as string) : null,
    occurredAtMs,
  };
}

// Shapes one v4 message object as a webhook-style envelope so the one
// parser handles both paths. The feed row keeps its evt_ id; the
// message supplies the ids, addresses, text and sender the row lacks.
function messageToEvent(thin: NormalizedEvent, message: Record<string, unknown>): NormalizedEvent | null {
  return parseBlooioEvent({
    id: thin.id,
    type: thin.rawType,
    occurred_at: thin.occurredAtMs,
    data: {
      ...message,
      message_id: message.id,
      occurred_at: message.created_at,
    },
  });
}

function errorCodeOf(status: number, body: unknown): string {
  if (isRecord(body)) {
    const code = asString(body.code) ?? asString(body.error);
    if (code) return code;
  }
  return `http_${status}`;
}

function errorTextOf(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.message === "string" && body.message) return body.message;
  return fallback;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class BlooioChannel implements Channel {
  readonly name = "blooio";
  private apiKey: string;
  private channelId: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(opts: BlooioOptions) {
    if (!opts.apiKey) throw new Error("A Blooio API key is required.");
    if (!opts.channelId) throw new Error("A Blooio channel ID is required.");
    this.apiKey = opts.apiKey;
    this.channelId = opts.channelId;
    this.baseUrl = (opts.baseUrl ?? BLOOIO_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.sleepFn = opts.sleepFn ?? sleepDefault;
  }

  parseEvent(raw: unknown): NormalizedEvent | null {
    return parseBlooioEvent(raw);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  private async readJson(res: Response): Promise<unknown> {
    return res.json().catch(() => ({}));
  }

  // One chat-scoped send when the chat is known (sender and recipient come
  // from the chat), else a channel-scoped send to the handle. 403 and 429
  // are refusals: recorded by the caller, never retried. 5xx retries with
  // backoff under the same idempotency key; anything still uncertain
  // throws ChannelUncertain so the caller looks the message up first.
  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    const path = input.chatId
      ? `/chats/${encodeURIComponent(input.chatId)}/messages`
      : `/channels/${encodeURIComponent(this.channelId)}/messages`;
    const body = input.chatId ? { text: input.text } : { to: input.to, text: input.text };
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
          method: "POST",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: this.headers({ "content-type": "application/json", "idempotency-key": input.idempotencyKey }),
          body: JSON.stringify(body),
        });
        const data = await this.readJson(res);
        if (res.ok) {
          const messageId = isRecord(data) ? asString(data.id) : null;
          const chatId = isRecord(data) ? asString(data.chat_id) : null;
          if (!messageId || !chatId) throw new Error("Blooio send returned no message id.");
          return { messageId, chatId, duplicate: res.status === 200 };
        }
        if (res.status === 403 || res.status === 409 || res.status === 429) {
          throw new ChannelRefused(res.status, errorCodeOf(res.status, data), errorTextOf(data, `Blooio refused the send: ${res.status}`));
        }
        // A definitive client error did not land: terminal, no retry.
        // 408 is the exception: a timeout may have landed, so it stays
        // uncertain and replays its key.
        if (res.status !== 408 && res.status < 500) {
          throw new ChannelFailed(res.status, errorCodeOf(res.status, data), errorTextOf(data, `Blooio send failed: ${res.status}`));
        }
        if (res.status < 500) {
          throw new Error(`Blooio send failed: ${res.status} ${errorCodeOf(res.status, data)}`);
        }
        lastErr = new Error(`Blooio send failed: ${res.status}`);
      } catch (err) {
        if (err instanceof ChannelRefused || err instanceof ChannelFailed) throw err;
        lastErr = err;
      }
      if (attempt < SEND_MAX_ATTEMPTS) await this.sleepFn(Math.min(1000 * 2 ** attempt, 8000));
    }
    throw new ChannelUncertain(
      lastErr instanceof Error ? lastErr.message : "Blooio send outcome unknown.",
      SEND_MAX_ATTEMPTS,
    );
  }

  async setTyping(chatId: string, state: "started" | "stopped"): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/chats/${encodeURIComponent(chatId)}/typing`, {
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ state }),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Blooio typing failed: ${res.status}`);
    }
  }

  async markRead(chatId: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/chats/${encodeURIComponent(chatId)}/read`, {
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Blooio mark-read failed: ${res.status}`);
    }
  }

  async lookupMessage(chatId: string, messageId: string): Promise<ChannelMessageStatus | null> {
    const res = await this.fetchFn(
      `${this.baseUrl}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      { signal: AbortSignal.timeout(SEND_TIMEOUT_MS), headers: this.headers() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Blooio message lookup failed: ${res.status}`);
    const data: unknown = await this.readJson(res);
    if (!isRecord(data)) return null;
    const error = isRecord(data.error) ? data.error : null;
    return {
      messageId: asString(data.id) ?? messageId,
      chatId: asString(data.chat_id) ?? chatId,
      status: asString(data.status) ?? "unknown",
      protocol: asString(data.protocol),
      errorCode: asString(error?.code),
    };
  }

  // The GET /events row names the message but carries no text or
  // sender, so reconcile fetches the full v4 message object (docs:
  // getChatMessage, verified live) and re-parses it as an event. The
  // feed's own evt_ id stays the event id; the DO dedupes the
  // cross-path double delivery by type plus message id.
  async hydrateEvent(event: NormalizedEvent): Promise<NormalizedEvent | null> {
    if (event.kind !== "message.received" || !event.chatId || !event.messageId) return null;
    const res = await this.fetchFn(
      `${this.baseUrl}/chats/${encodeURIComponent(event.chatId)}/messages/${encodeURIComponent(event.messageId)}`,
      { signal: AbortSignal.timeout(SEND_TIMEOUT_MS), headers: this.headers() },
    );
    // Gone or unreadable under this key: retrying cannot help.
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Blooio message fetch failed: ${res.status}`);
    const data: unknown = await this.readJson(res);
    const message = isRecord(data) && isRecord(data.data) ? data.data : isRecord(data) ? data : null;
    if (!message) return null;
    return messageToEvent(event, message);
  }

  async listEvents(cursor: string | null, limit: number): Promise<ChannelEventPage> {
    const url = new URL(`${this.baseUrl}/events`);
    url.searchParams.set("limit", String(Math.max(1, Math.min(200, limit))));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await this.fetchFn(url.toString(), {
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Blooio event feed failed: ${res.status}`);
    const data: unknown = await this.readJson(res);
    const items = isRecord(data) && Array.isArray(data.data) ? data.data : [];
    const events: NormalizedEvent[] = [];
    for (const item of items) {
      const parsed = parseBlooioEvent(item);
      if (parsed) events.push(parsed);
    }
    const nextCursor = isRecord(data) ? (asString(data.next_cursor) ?? null) : null;
    return { events, nextCursor };
  }
}
