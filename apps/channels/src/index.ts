// mano-channels: the only part of Mano that talks to a messaging
// provider. Webhook ingress verifies and enqueues; the queue consumer
// routes events to one ConversationDO per handle; a cron reconciles
// anything the webhook missed through the same queue.
import { ENGINE_SEND_SIGNATURE_HEADER, ENGINE_SEND_TIMESTAMP_HEADER, verifyEngineSend } from "@mano/protocol";
import {
  ATTACHMENT_RETENTION_MS,
  BlooioChannel,
  RecordingChannel,
  createLogger,
  errName,
  hashChatId,
  hashHandle,
  lifecycleStateFor,
  normalizeHandle,
  parseBlooioEvent,
  verifySignature,
  type Channel,
  type NormalizedEvent,
} from "@mano/channels";
import type { Env } from "./env.js";
import { globalStateStub } from "./conversation.js";
import { R2FileStore, type FileStore } from "./files.js";

export { ConversationDO } from "./conversation.js";
export { ChannelStateDO } from "./state.js";

const WEBHOOK_PATH = "/webhooks/blooio";
const AGENT_SEND_PATH = "/internal/agent-send";
const RECONCILE_LIMIT = 100;
const RECONCILE_MAX_PAGES = 5;
const SWEEP_LIMIT = 1000;

function workerChannel(env: Env): Channel {
  if (env.BLOOIO_API_KEY && env.BLOOIO_CHANNEL_ID) {
    return new BlooioChannel({ apiKey: env.BLOOIO_API_KEY, channelId: env.BLOOIO_CHANNEL_ID, baseUrl: env.BLOOIO_BASE_URL || undefined });
  }
  return new RecordingChannel();
}

// True only when both sides name a line and they differ. Anything
// unverifiable is accepted: the signature is the real proof, this is
// defense in depth.
function wrongLine(address: string | null, lineNumber: string | undefined): boolean {
  if (!address || !lineNumber) return false;
  const want = normalizeHandle(lineNumber);
  const got = normalizeHandle(address);
  return !!want && !!got && want !== got;
}

// Ingress: read the raw body once, verify over the raw bytes, decode,
// scope to our line, enqueue, return. Nothing else in the request path.
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const logger = createLogger();
  if (!env.BLOOIO_WEBHOOK_SECRET) {
    logger.warn("webhook_unconfigured", {});
    return new Response("Not configured.", { status: 500 });
  }
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  const check = await verifySignature(
    rawBytes,
    request.headers.get("x-blooio-signature"),
    env.BLOOIO_WEBHOOK_SECRET,
    Math.floor(started / 1000),
  );
  if (!check.ok) {
    logger.warn("webhook_rejected", { reason: check.failure ?? "unknown", ageSeconds: check.ageSeconds ?? null });
    return new Response("Bad signature.", { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return new Response("Bad JSON.", { status: 400 });
  }
  const event = parseBlooioEvent(parsed);
  if (!event) {
    logger.info("webhook_ignored", { reason: "not_an_event", durationMs: Date.now() - started });
    return new Response("Ignored.", { status: 202 });
  }
  // Our webhook is scoped to our line and the signature proves the event
  // came through it, so a missing channel_id is accepted. A present but
  // different id, or an address naming another line, is ignored.
  if (event.channelId && event.channelId !== env.BLOOIO_CHANNEL_ID) {
    logger.info("webhook_ignored", {
      reason: "wrong_channel",
      eventId: event.id,
      type: event.rawType,
      durationMs: Date.now() - started,
    });
    return new Response("Ignored.", { status: 202 });
  }
  if (wrongLine(event.channelAddress, env.MANO_TEXT_NUMBER)) {
    logger.info("webhook_ignored", {
      reason: "wrong_address",
      eventId: event.id,
      type: event.rawType,
      durationMs: Date.now() - started,
    });
    return new Response("Ignored.", { status: 202 });
  }
  await env.EVENTS.send(event);
  logger.info("webhook_enqueued", {
    eventId: event.id,
    type: event.rawType,
    chat: event.chatId ? await hashChatId(event.chatId, env.MANO_HANDLE_PEPPER) : null,
    durationMs: Date.now() - started,
  });
  return new Response("Queued.", { status: 200 });
}

// One event, one conversation. Throws to redeliver; the event log in the
// DO makes redelivery safe. Delivery receipts that name no recipient
// route by their chat instead, through the route table the conversations
// keep.
export async function routeEvent(event: NormalizedEvent, env: Env): Promise<"routed" | "skipped"> {
  const logger = createLogger();
  if (event.kind === "ignored") {
    logger.info("event_skipped", { eventId: event.id, type: event.rawType });
    return "skipped";
  }
  let handleHash = event.handle ? await hashHandle(event.handle, env.MANO_HANDLE_PEPPER) : null;
  // Receipts, typing and reactions often name only the chat: they route
  // through the chat table the conversations keep.
  const routesByChat =
    lifecycleStateFor(event.kind) !== null || event.kind === "typing.started" || event.kind === "typing.stopped" || event.kind === "reaction";
  if (!handleHash && event.chatId && routesByChat) {
    handleHash = await routeForChat(env, event.chatId);
  }
  if (!handleHash) {
    logger.info("event_skipped", { eventId: event.id, type: event.rawType, reason: "unroutable" });
    return "skipped";
  }
  const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(handleHash));
  const res = await stub.fetch("https://conversation/internal/event", {
    method: "POST",
    body: JSON.stringify({ handleHash, event }),
  });
  if (!res.ok) throw new Error(`Conversation route failed: ${res.status}`);
  const data = (await res.json()) as { result?: string };
  logger.info("event_routed", { eventId: event.id, type: event.rawType, handle: handleHash, result: data.result ?? "unknown" });
  return "routed";
}

async function routeForChat(env: Env, chatId: string): Promise<string | null> {
  const chat = await hashChatId(chatId, env.MANO_HANDLE_PEPPER);
  const res = await globalStateStub(env).fetch(`https://state/internal/route?chat=${encodeURIComponent(chat)}`);
  if (!res.ok) throw new Error(`Route lookup failed: ${res.status}`);
  return ((await res.json()) as { handleHash: string | null }).handleHash;
}

async function readCursor(env: Env): Promise<string | null> {
  const res = await globalStateStub(env).fetch("https://state/internal/cursor");
  if (!res.ok) throw new Error(`Cursor read failed: ${res.status}`);
  return ((await res.json()) as { cursor: string | null }).cursor;
}

async function saveCursor(env: Env, cursor: string | null): Promise<void> {
  await globalStateStub(env).fetch("https://state/internal/cursor", {
    method: "POST",
    body: JSON.stringify({ cursor }),
  });
}

// Reconciliation: page the provider's event feed since the last cursor
// and enqueue anything for our line. Feed rows are thin (no channel,
// text or sender), so inbound receipts hydrate their message before
// queueing; anything else for our line queues directly. Skipped rows
// are still marked seen so the cursor keeps moving, and a page the
// provider serves again is filtered through the seen high-watermark,
// so only new events requeue; the DO event log dedupes the rest.
export async function reconcile(env: Env, channel?: Channel): Promise<{ pages: number; enqueued: number }> {
  const logger = createLogger();
  const feed = channel ?? workerChannel(env);
  let cursor = await readCursor(env);
  let pages = 0;
  let enqueued = 0;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    const batch = await feed.listEvents(cursor, RECONCILE_LIMIT);
    pages += 1;
    const unseen = new Set(await checkUnseen(env, batch.events.map((event) => event.id)));
    const seen: string[] = [];
    for (const event of batch.events) {
      if (!unseen.has(event.id)) continue;
      const full = await hydrateForReconcile(feed, event, env, logger);
      if (full === "paused") {
        // Transient fetch failure: keep the cursor here so the next
        // run retries this page; rows already handled stay marked.
        await noteSeenIds(env, seen);
        logger.info("reconciled", { pages, enqueued });
        return { pages, enqueued };
      }
      if (full) {
        await env.EVENTS.send(full);
        enqueued += 1;
      }
      seen.push(event.id);
    }
    // Noted only after the queue accepted them: a throw above leaves
    // the page unmarked, and the next run retries it.
    await noteSeenIds(env, seen);
    // No next cursor means the feed is drained; keep the last cursor so
    // the next run resumes instead of rereading from the start.
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
    await saveCursor(env, cursor);
  }
  logger.info("reconciled", { pages, enqueued });
  return { pages, enqueued };
}

// One feed row to zero or one queueable event. Thin inbound rows fetch
// their message; rows already naming our line queue as parsed. Null
// means seen and skipped (gone, unreadable, or another line's);
// "paused" means the fetch failed transiently and the run must stop.
async function hydrateForReconcile(
  feed: Channel,
  event: NormalizedEvent,
  env: Env,
  logger: ReturnType<typeof createLogger>,
): Promise<NormalizedEvent | null | "paused"> {
  if (event.channelId === env.BLOOIO_CHANNEL_ID) return event;
  if (event.kind !== "message.received" || !event.chatId || !event.messageId) return null;
  try {
    const full = await feed.hydrateEvent(event);
    if (!full || full.channelId !== env.BLOOIO_CHANNEL_ID) return null;
    return full;
  } catch (err) {
    logger.warn("reconcile_paused", { err: errName(err) });
    return "paused";
  }
}

async function checkUnseen(env: Env, ids: string[]): Promise<string[]> {
  const res = await globalStateStub(env).fetch("https://state/internal/seen-check", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`Seen check failed: ${res.status}`);
  return ((await res.json()) as { unseen: string[] }).unseen;
}

async function noteSeenIds(env: Env, ids: string[]): Promise<void> {
  await globalStateStub(env).fetch("https://state/internal/seen-note", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

// Dead letters record the event ID and reason, then drop the body. The
// full event, with its message text, never sits in the DLQ.
export function handleDeadLetters(batch: MessageBatch<unknown>): void {
  const logger = createLogger();
  for (const message of batch.messages) {
    const body = message.body as { id?: unknown; rawType?: unknown; kind?: unknown };
    logger.warn("event_dead_letter", {
      eventId: String(body?.id ?? "unknown"),
      type: String(body?.rawType ?? body?.kind ?? "unknown"),
    });
    message.ack();
  }
}

// Stored attachments expire 30 days after upload. The cron deletes the
// oldest batch each run until none remain.
export async function sweepExpiredFiles(files: FileStore, nowMs: number): Promise<{ deleted: number }> {
  const keys = await files.listOlderThan("persons/", nowMs - ATTACHMENT_RETENTION_MS, SWEEP_LIMIT);
  const deleted = keys.length > 0 ? await files.deleteKeys(keys) : 0;
  if (deleted > 0) createLogger().info("files_swept", { deleted });
  return { deleted };
}

// Engine-started deliveries (due reminders). Engine signs each with
// MANO_ENGINE_SEND_SECRET over the method, this route's path, the
// timestamp and the raw body (packages/protocol engine-send.ts); that
// secret is accepted on this route only, and the agent's secret is not.
// Then routed to the conversation, which sends through the normal
// outbound path under the generation the reminder was set in. Terminal
// outcomes answer 200 {sent:false, reason} with a non-empty reason, so
// Engine drops them; budget (429) and anything uncertain ask it to retry.
export async function handleAgentSend(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const logger = createLogger();
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  const check = await verifyEngineSend(
    env.MANO_ENGINE_SEND_SECRET,
    {
      method: request.method.toUpperCase(),
      path: new URL(request.url).pathname,
      timestamp: request.headers.get(ENGINE_SEND_TIMESTAMP_HEADER),
      signature: request.headers.get(ENGINE_SEND_SIGNATURE_HEADER),
      body: rawBytes,
    },
    Math.floor(started / 1000),
  );
  if (!check.ok) {
    logger.warn("agent_send_rejected", { reason: check.reason });
    return new Response("Bad signature.", { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return new Response("Bad JSON.", { status: 400 });
  }
  const body = parsed as { handleHash?: unknown; key?: unknown; text?: unknown; generation?: unknown };
  if (
    typeof body.handleHash !== "string" ||
    !body.handleHash ||
    typeof body.key !== "string" ||
    !body.key ||
    typeof body.text !== "string" ||
    !body.text ||
    typeof body.generation !== "number" ||
    !Number.isInteger(body.generation) ||
    body.generation < 0
  ) {
    return new Response("Bad agent send.", { status: 400 });
  }
  const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(body.handleHash));
  const res = await stub.fetch("https://conversation/internal/agent-send", {
    method: "POST",
    body: JSON.stringify({ handleHash: body.handleHash, key: body.key, text: body.text, generation: body.generation }),
  });
  const data = (await res.json().catch(() => ({}))) as { sent?: unknown; reason?: unknown };
  // A refusal must name its reason, or Engine could not tell it from an
  // unreadable answer; anything else is reported as uncertain.
  if (res.ok && data.sent !== true && (typeof data.reason !== "string" || !data.reason)) {
    logger.warn("agent_send_unclear", { handle: body.handleHash, status: res.status });
    return Response.json({ sent: false, reason: null }, { status: 502 });
  }
  logger.info("agent_send_routed", {
    handle: body.handleHash,
    sent: data.sent === true,
    reason: typeof data.reason === "string" ? data.reason : null,
    status: res.status,
    durationMs: Date.now() - started,
  });
  return Response.json({ sent: data.sent ?? false, reason: data.reason ?? null }, { status: res.status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === AGENT_SEND_PATH) {
      return handleAgentSend(request, env);
    }
    // Local end-to-end runs only: deletes one conversation by its handle.
    // Exists only when MANO_DEV_ROUTES is "1", which no deployment sets.
    if (env.MANO_DEV_ROUTES === "1" && request.method === "POST" && url.pathname === "/dev/delete") {
      const body = (await request.json().catch(() => null)) as { handle?: unknown } | null;
      const handle = typeof body?.handle === "string" ? normalizeHandle(body.handle) : null;
      if (!handle) return new Response("Bad delete.", { status: 400 });
      const handleHash = await hashHandle(handle, env.MANO_HANDLE_PEPPER);
      const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(handleHash));
      return stub.fetch("https://conversation/internal/delete", { method: "POST", body: JSON.stringify({ handleHash }) });
    }
    // Ok and nothing else: strangers must not learn which keys are set.
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Not found.", { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "mano-channel-events-dlq") {
      handleDeadLetters(batch);
      return;
    }
    for (const message of batch.messages) {
      const event = message.body as NormalizedEvent;
      try {
        await routeEvent(event, env);
        message.ack();
      } catch (err) {
        createLogger().warn("event_route_failed", {
          eventId: String((event as { id?: unknown })?.id ?? "unknown"),
          err: errName(err),
        });
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // A failing tick must log and end, never exception: an uncaught
    // cron error is invisible except in tail, and it skips the sweep.
    const logger = createLogger();
    try {
      await reconcile(env);
    } catch (err) {
      logger.warn("reconcile_failed", { err: errName(err) });
    }
    try {
      await sweepExpiredFiles(new R2FileStore(env.FILES), Date.now());
    } catch (err) {
      logger.warn("sweep_failed", { err: errName(err) });
    }
  },
};
