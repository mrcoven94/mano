// mano-channels: the only part of Mano that talks to a messaging
// provider. Webhook ingress verifies and enqueues; the queue consumer
// routes events to one ConversationDO per handle; a cron reconciles
// anything the webhook missed through the same queue.
import {
  ATTACHMENT_RETENTION_MS,
  BlooioChannel,
  RecordingChannel,
  createLogger,
  hashChatId,
  hashHandle,
  lifecycleStateFor,
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
const RECONCILE_LIMIT = 100;
const RECONCILE_MAX_PAGES = 5;
const SWEEP_LIMIT = 1000;

function workerChannel(env: Env): Channel {
  if (env.BLOOIO_API_KEY && env.BLOOIO_CHANNEL_ID) {
    return new BlooioChannel({ apiKey: env.BLOOIO_API_KEY, channelId: env.BLOOIO_CHANNEL_ID });
  }
  return new RecordingChannel();
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
  if (event.channelId !== env.BLOOIO_CHANNEL_ID) {
    logger.info("webhook_ignored", {
      reason: "wrong_channel",
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
  if (event.kind === "ignored" || event.kind === "typing.started" || event.kind === "typing.stopped") {
    logger.info("event_skipped", { eventId: event.id, type: event.rawType });
    return "skipped";
  }
  let handleHash = event.handle ? await hashHandle(event.handle, env.MANO_HANDLE_PEPPER) : null;
  if (!handleHash && event.chatId && lifecycleStateFor(event.kind)) {
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
// and enqueue anything for our line. A page the provider serves again
// (no next cursor) is filtered through the seen high-watermark, so only
// new events requeue; the DO event log dedupes the rest.
export async function reconcile(env: Env, channel?: Channel): Promise<{ pages: number; enqueued: number }> {
  const logger = createLogger();
  const feed = channel ?? workerChannel(env);
  let cursor = await readCursor(env);
  let pages = 0;
  let enqueued = 0;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    const batch = await feed.listEvents(cursor, RECONCILE_LIMIT);
    pages += 1;
    const ours = batch.events.filter((event) => event.channelId === env.BLOOIO_CHANNEL_ID);
    const unseen = new Set(await checkUnseen(env, ours.map((event) => event.id)));
    const queued: string[] = [];
    for (const event of ours) {
      if (!unseen.has(event.id)) continue;
      await env.EVENTS.send(event);
      queued.push(event.id);
      enqueued += 1;
    }
    // Noted only after the queue accepted them: a throw above leaves
    // the page unmarked, and the next run retries it.
    await noteSeenIds(env, queued);
    // No next cursor means the feed is drained; keep the last cursor so
    // the next run resumes instead of rereading from the start.
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
    await saveCursor(env, cursor);
  }
  logger.info("reconciled", { pages, enqueued });
  return { pages, enqueued };
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleWebhook(request, env);
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
          err: err instanceof Error ? err.message : "unknown",
        });
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await reconcile(env);
    await sweepExpiredFiles(new R2FileStore(env.FILES), Date.now());
  },
};
