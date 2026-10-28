// ConversationDO: one Durable Object per handle, keyed by the hashed
// handle. It owns the event log, the outbound state machine and the turn
// runner for exactly one conversation. Internal routes only; the worker
// reaches them from the queue consumer, never from the public internet.
import {
  BlooioChannel,
  RecordingChannel,
  boundFetch,
  SparkResponder,
  StandInResponder,
  buildModelBaseUrl,
  createLogger,
  hashChatId,
  type Channel,
  type Logger,
  type NormalizedEvent,
  type Responder,
} from "@mano/channels";
import { DEFAULT_MEDIA_HOSTS, DEFAULT_RUNNER_CONFIG, ConversationRunner, type SpendLedger } from "./runner.js";

export function parseMediaHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : [...DEFAULT_MEDIA_HOSTS];
}
import { R2FileStore, conversationFilePrefix } from "./files.js";
import { SqlConversationStore } from "./store-sql.js";
import { numberEnv, type Env } from "./env.js";

export const GLOBAL_STATE_ID = "global";

class StateSpendLedger implements SpendLedger {
  private stub: DurableObjectStub;
  constructor(stub: DurableObjectStub) {
    this.stub = stub;
  }

  async reserve(key: string, worstUsd: number): Promise<{ allowed: boolean; spentUsd: number }> {
    const res = await this.stub.fetch("https://state/internal/spend-reserve", {
      method: "POST",
      body: JSON.stringify({ key, worstUsd }),
    });
    return (await res.json()) as { allowed: boolean; spentUsd: number };
  }

  async settle(key: string, actualUsd: number): Promise<void> {
    await this.stub.fetch("https://state/internal/spend-settle", {
      method: "POST",
      body: JSON.stringify({ key, actualUsd }),
    });
  }

  async release(key: string): Promise<void> {
    await this.stub.fetch("https://state/internal/spend-release", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  }

  async byteReserve(key: string, bytes: number): Promise<{ allowed: boolean; bytesUsed: number }> {
    const res = await this.stub.fetch("https://state/internal/bytes-reserve", {
      method: "POST",
      body: JSON.stringify({ key, bytes }),
    });
    return (await res.json()) as { allowed: boolean; bytesUsed: number };
  }

  async byteSettle(key: string, actualBytes: number): Promise<void> {
    await this.stub.fetch("https://state/internal/bytes-settle", {
      method: "POST",
      body: JSON.stringify({ key, actualBytes }),
    });
  }

  async byteRelease(key: string): Promise<void> {
    await this.stub.fetch("https://state/internal/bytes-release", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  }
}

export function globalStateStub(env: Env): DurableObjectStub {
  return env.CHANNEL_STATE.get(env.CHANNEL_STATE.idFromName(GLOBAL_STATE_ID));
}

export function buildChannel(env: Env): Channel {
  if (env.BLOOIO_API_KEY && env.BLOOIO_CHANNEL_ID) {
    return new BlooioChannel({ apiKey: env.BLOOIO_API_KEY, channelId: env.BLOOIO_CHANNEL_ID });
  }
  return new RecordingChannel();
}

export function buildResponder(env: Env): Responder {
  if (env.META_MODEL_API_KEY) {
    const endpoint = buildModelBaseUrl({
      accountId: env.CF_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID,
      provider: env.AI_GATEWAY_PROVIDER,
    });
    return new SparkResponder({ apiKey: env.META_MODEL_API_KEY, baseUrl: endpoint.url, collectLogs: endpoint.via === "direct" });
  }
  return new StandInResponder();
}

export class ConversationDO implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;
  private logger: Logger;
  // Serializes turns across requests in one isolate, so an unfinished
  // row always means the last attempt died rather than a concurrent run.
  private turnChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.logger = createLogger();
  }

  private runTurnSerialized(handleHash: string): Promise<{ result: import("./runner.js").TurnResult; retryAfterMs: number }> {
    const next = this.turnChain.then(async () => {
      const { runner } = this.runner(handleHash);
      const result = await runner.runDueTurn();
      return { result, retryAfterMs: runner.retryAfterMs() };
    });
    this.turnChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private runner(handleHash: string): { runner: ConversationRunner; channel: Channel; responder: Responder } {
    const channel = buildChannel(this.env);
    const responder = buildResponder(this.env);
    const runner = new ConversationRunner({
      store: new SqlConversationStore(this.ctx.storage.sql),
      channel,
      responder,
      files: this.env.FILES ? new R2FileStore(this.env.FILES) : null,
      kekB64: this.env.ENCRYPTION_KEK_B64 || null,
      spend: new StateSpendLedger(globalStateStub(this.env)),
      logger: this.logger,
      nowMs: () => Date.now(),
      fetchFn: boundFetch,
      config: {
        handleHash,
        batchMs: numberEnv(this.env.TURN_BATCH_MS, DEFAULT_RUNNER_CONFIG.batchMs),
        interimMs: numberEnv(this.env.TURN_INTERIM_MS, DEFAULT_RUNNER_CONFIG.interimMs),
        budgetUsd: numberEnv(this.env.MANO_TEXT_DAILY_BUDGET_USD, DEFAULT_RUNNER_CONFIG.budgetUsd),
        usdPer1kChars: numberEnv(this.env.MANO_TEXT_USD_PER_1K_CHARS, DEFAULT_RUNNER_CONFIG.usdPer1kChars),
        maxInboundAgeMs: DEFAULT_RUNNER_CONFIG.maxInboundAgeMs,
        mediaHosts: parseMediaHosts(this.env.BLOOIO_MEDIA_HOSTS),
      },
    });
    return { runner, channel, responder };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/event") {
      const body = (await request.json().catch(() => null)) as { handleHash?: unknown; personId?: unknown; event?: unknown } | null;
      if (!body || typeof body.handleHash !== "string" || !body.event) {
        return new Response("Bad event.", { status: 400 });
      }
      const { runner } = this.runner(body.handleHash);
      const event = body.event as NormalizedEvent;
      const result = await runner.handleEvent(event, "webhook");
      // First sight of a handle binds it to its person. True once per
      // handle: that is the create in create-or-route.
      let personCreated: boolean | null = null;
      if (typeof body.personId === "string" && body.personId) {
        const bind = await globalStateStub(this.env).fetch("https://state/internal/person-bind", {
          method: "POST",
          body: JSON.stringify({ handleHash: body.handleHash, personId: body.personId }),
        });
        if (bind.ok) personCreated = ((await bind.json()) as { created?: unknown }).created === true;
      }
      // Every event with a chat refreshes the chat route, keyed by hash,
      // so handle-less delivery receipts find this conversation later.
      if (event.chatId) {
        const chat = await hashChatId(event.chatId, this.env.MANO_HANDLE_PEPPER);
        await globalStateStub(this.env).fetch("https://state/internal/route", {
          method: "POST",
          body: JSON.stringify({ chat, handleHash: body.handleHash }),
        });
      }
      const batchMs = numberEnv(this.env.TURN_BATCH_MS, DEFAULT_RUNNER_CONFIG.batchMs);
      if (result === "queued") {
        await this.ctx.storage.setAlarm(Date.now() + batchMs);
      } else if (result === "duplicate") {
        // A redelivery while input waits with no alarm means the alarm
        // fired into a crash or was lost: re-arm it so the turn runs.
        const store = new SqlConversationStore(this.ctx.storage.sql);
        if (store.pending().length > 0 && (await this.ctx.storage.getAlarm()) === null) {
          await this.ctx.storage.setAlarm(Date.now() + batchMs);
        }
      }
      return Response.json({ result, personCreated });
    }
    if (request.method === "POST" && url.pathname === "/internal/send-code") {
      const body = (await request.json().catch(() => null)) as {
        handleHash?: unknown;
        to?: unknown;
        message?: unknown;
        idempotencyKey?: unknown;
      } | null;
      if (
        !body || typeof body.handleHash !== "string" || typeof body.to !== "string" ||
        typeof body.message !== "string" || typeof body.idempotencyKey !== "string" ||
        !body.to || !body.message || !body.idempotencyKey
      ) {
        return new Response("Bad code send.", { status: 400 });
      }
      const { runner } = this.runner(body.handleHash);
      const sent = await runner.sendCode(body.to, body.message, body.idempotencyKey);
      return Response.json({ key: sent.key, state: sent.state, code: sent.code });
    }
    if (request.method === "POST" && url.pathname === "/internal/turn") {
      const body = (await request.json().catch(() => null)) as { handleHash?: unknown } | null;
      if (!body || typeof body.handleHash !== "string") return new Response("Bad turn.", { status: 400 });
      const { result, retryAfterMs } = await this.runTurnSerialized(body.handleHash);
      const batchMs = numberEnv(this.env.TURN_BATCH_MS, DEFAULT_RUNNER_CONFIG.batchMs);
      if (result === "waiting") {
        await this.ctx.storage.setAlarm(Date.now() + batchMs);
      } else if (result === "retry") {
        await this.ctx.storage.setAlarm(Date.now() + retryAfterMs);
      } else if (result === "ran") {
        const store = new SqlConversationStore(this.ctx.storage.sql);
        if (store.pending().length > 0) {
          await this.ctx.storage.setAlarm(Date.now() + batchMs);
        }
      }
      return Response.json({ result });
    }
    if (request.method === "POST" && url.pathname === "/internal/approval") {
      const body = (await request.json().catch(() => null)) as {
        handleHash?: unknown;
        id?: unknown;
        code?: unknown;
        summary?: unknown;
        ttlMs?: unknown;
      } | null;
      if (!body || typeof body.handleHash !== "string" || typeof body.id !== "string" || typeof body.code !== "string") {
        return new Response("Bad approval.", { status: 400 });
      }
      const { runner } = this.runner(body.handleHash);
      await runner.requestApproval({
        id: body.id,
        code: body.code,
        summary: typeof body.summary === "string" ? body.summary : "",
        ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : 15 * 60 * 1000,
      });
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/internal/delete") {
      const body = (await request.json().catch(() => null)) as { handleHash?: unknown } | null;
      if (!body || typeof body.handleHash !== "string") return new Response("Bad delete.", { status: 400 });
      new SqlConversationStore(this.ctx.storage.sql).wipe(Date.now());
      let filesDeleted = 0;
      if (this.env.FILES) {
        filesDeleted = await new R2FileStore(this.env.FILES).deletePrefix(conversationFilePrefix(body.handleHash));
      }
      await this.ctx.storage.deleteAlarm();
      this.logger.info("conversation_deleted", { handle: body.handleHash, filesDeleted });
      return Response.json({ ok: true, filesDeleted });
    }
    if (request.method === "GET" && url.pathname === "/internal/standin") {
      // Only reachable when no provider key is configured, in which case
      // the channel is the recording stand-in. Returns 404 live. Reads
      // the outbox from SQLite, so it survives instance restarts.
      if (this.env.BLOOIO_API_KEY && this.env.BLOOIO_CHANNEL_ID) {
        return new Response("Not found.", { status: 404 });
      }
      const store = new SqlConversationStore(this.ctx.storage.sql);
      return Response.json({
        sends: store.outbounds().map((o) => ({ key: o.key, state: o.state, message: o.messageId, code: o.code })),
        turn: store.meta().turn,
        introduced: store.meta().introduced,
        pending: store.pending().length,
        approvals: store.pendingApprovals(Date.now()).length,
      });
    }
    return new Response("Not found.", { status: 404 });
  }

  async alarm(): Promise<void> {
    const { result, retryAfterMs } = await this.runTurnSerialized(this.ctx.id.name ?? this.ctx.id.toString());
    const batchMs = numberEnv(this.env.TURN_BATCH_MS, DEFAULT_RUNNER_CONFIG.batchMs);
    if (result === "retry") {
      await this.ctx.storage.setAlarm(Date.now() + retryAfterMs);
    } else if (result === "waiting" || (result === "ran" && new SqlConversationStore(this.ctx.storage.sql).pending().length > 0)) {
      await this.ctx.storage.setAlarm(Date.now() + batchMs);
    }
  }
}
