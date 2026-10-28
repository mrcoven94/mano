// mano-channels: the only part of Mano that talks to a messaging
// provider. Webhook ingress verifies and enqueues; the queue consumer
// routes events to one ConversationDO per handle; a cron reconciles
// anything the webhook missed through the same queue.
import {
  BlooioChannel,
  RecordingChannel,
  createLogger,
  hashHandle,
  parseBlooioEvent,
  verifySignature,
  type Channel,
  type NormalizedEvent,
} from "@mano/channels";
import type { Env } from "./env.js";
import { globalStateStub } from "./conversation.js";

export { ConversationDO } from "./conversation.js";
export { ChannelStateDO } from "./state.js";

const WEBHOOK_PATH = "/webhooks/blooio";
const RECONCILE_LIMIT = 100;
const RECONCILE_MAX_PAGES = 5;

function workerChannel(env: Env): Channel {
  if (env.BLOOIO_API_KEY && env.BLOOIO_CHANNEL_ID) {
    return new BlooioChannel({ apiKey: env.BLOOIO_API_KEY, channelId: env.BLOOIO_CHANNEL_ID });
  }
  return new RecordingChannel();
}

// Ingress: read the raw body once, verify, scope to our line, enqueue,
// return. Nothing else in the request path.
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const logger = createLogger();
  if (!env.BLOOIO_WEBHOOK_SECRET) {
    logger.warn("webhook_unconfigured", {});
    return new Response("Not configured.", { status: 500 });
  }
  const rawBody = await request.text();
  const check = await verifySignature(rawBody, request.headers.get("x-blooio-signature"), env.BLOOIO_WEBHOOK_SECRET, Math.floor(started / 1000));
  if (!check.ok) {
    logger.warn("webhook_rejected", { reason: check.failure ?? "unknown", ageSeconds: check.ageSeconds ?? null });
    return new Response("Bad signature.", { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
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
    chat: event.chatId,
    durationMs: Date.now() - started,
  });
  return new Response("Queued.", { status: 200 });
}

// One event, one conversation. Throws to redeliver; the event log in the
// DO makes redelivery safe.
export async function routeEvent(event: NormalizedEvent, env: Env): Promise<"routed" | "skipped"> {
  const logger = createLogger();
  if (!event.handle || event.kind === "ignored" || event.kind === "typing.started" || event.kind === "typing.stopped") {
    logger.info("event_skipped", { eventId: event.id, type: event.rawType });
    return "skipped";
  }
  const handleHash = await hashHandle(event.handle, env.MANO_HANDLE_PEPPER);
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
// and enqueue anything for our line. Dedupe in the DO makes replays safe.
export async function reconcile(env: Env, channel?: Channel): Promise<{ pages: number; enqueued: number }> {
  const logger = createLogger();
  const feed = channel ?? workerChannel(env);
  let cursor = await readCursor(env);
  let pages = 0;
  let enqueued = 0;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    const batch = await feed.listEvents(cursor, RECONCILE_LIMIT);
    pages += 1;
    for (const event of batch.events) {
      if (event.channelId !== env.BLOOIO_CHANNEL_ID) continue;
      await env.EVENTS.send(event);
      enqueued += 1;
    }
    // No next cursor means the feed is drained; keep the last cursor so
    // the next run resumes instead of rereading from the start.
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
    await saveCursor(env, cursor);
  }
  logger.info("reconciled", { pages, enqueued });
  return { pages, enqueued };
}

function liveness(env: Env): { blooio: boolean; model: boolean; files: boolean } {
  return {
    blooio: !!(env.BLOOIO_API_KEY && env.BLOOIO_CHANNEL_ID),
    model: !!env.META_MODEL_API_KEY,
    files: !!env.ENCRYPTION_KEK_B64,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleWebhook(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const live = liveness(env);
      return Response.json({ ok: true, live });
    }
    return new Response("Not found.", { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
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
  },
};
