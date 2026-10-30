// ConversationDO: one Durable Object per handle, keyed by the hashed
// handle. It owns the event log, the outbound state machine and the turn
// runner for exactly one conversation. Internal routes only; the worker
// reaches them from the queue consumer, never from the public internet.
import {
  AgentResponder,
  reportPresentation,
  BlooioChannel,
  RecordingChannel,
  boundFetch,
  SparkResponder,
  StandInResponder,
  buildModelBaseUrl,
  createLogger,
  errName,
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
import {
  advanceDelete,
  agentConfigured,
  clearPendingDelete,
  isDone,
  loadPendingDelete,
  newPendingDelete,
  retryDelayMs,
  savePendingDelete,
} from "./conversation-delete.js";
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
    return new BlooioChannel({ apiKey: env.BLOOIO_API_KEY, channelId: env.BLOOIO_CHANNEL_ID, baseUrl: env.BLOOIO_BASE_URL || undefined });
  }
  return new RecordingChannel();
}

// Real texts go only to a Standard model ID (AGENTS.md rule 7). A
// missing or -contributor ID fails closed to the stand-in, which calls
// no model.
function buildFallbackResponder(env: Env): Responder {
  const model = env.MANO_REPLY_MODEL ?? "";
  if (!env.META_MODEL_API_KEY || !model || model.endsWith("-contributor")) return new StandInResponder();
  const endpoint = buildModelBaseUrl({
    accountId: env.CF_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    provider: env.AI_GATEWAY_PROVIDER,
  });
  return new SparkResponder({ apiKey: env.META_MODEL_API_KEY, model, baseUrl: endpoint.url, collectLogs: endpoint.via === "direct" });
}

export function buildResponder(env: Env, handleHash?: string, opts: { agentAllowed?: boolean } = {}): Responder {
  const fallback = buildFallbackResponder(env);
  if (opts.agentAllowed === false) return fallback;
  // The agent answers when configured; otherwise the plain model answer
  // stays the responder, and the agent falls back to it per turn.
  if (env.AGENT_URL && env.MANO_AGENT_SECRET && env.MANO_HANDLE_GRANT_SECRET && handleHash) {
    return new AgentResponder({
      agentUrl: env.AGENT_URL,
      secret: env.MANO_AGENT_SECRET,
      grantSecret: env.MANO_HANDLE_GRANT_SECRET,
      handleHash,
      fallback,
    });
  }
  return fallback;
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
    // While a delete waits for Engine, old approvals could still be
    // answered, so the agent is not used: the plain model answers.
    const responder = buildResponder(this.env, handleHash, { agentAllowed: loadPendingDelete(this.ctx.storage.sql) === null });
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
      reportPresentation: agentConfigured(this.env)
        ? (p, sentTexts) =>
            reportPresentation({
              agentUrl: this.env.AGENT_URL!,
              secret: this.env.MANO_AGENT_SECRET!,
              grantSecret: this.env.MANO_HANDLE_GRANT_SECRET!,
              handleHash,
              ...p,
              sentTexts,
            })
        : undefined,
      config: {
        handleHash,
        batchMs: numberEnv(this.env.TURN_BATCH_MS, DEFAULT_RUNNER_CONFIG.batchMs),
        interimMs: numberEnv(this.env.TURN_INTERIM_MS, DEFAULT_RUNNER_CONFIG.interimMs),
        typingRefreshMs: DEFAULT_RUNNER_CONFIG.typingRefreshMs,
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
      const body = (await request.json().catch(() => null)) as { handleHash?: unknown; event?: unknown } | null;
      if (!body || typeof body.handleHash !== "string" || !body.event) {
        return new Response("Bad event.", { status: 400 });
      }
      const { runner } = this.runner(body.handleHash);
      const event = body.event as NormalizedEvent;
      const result = await runner.handleEvent(event, "webhook");
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
      return Response.json({ result });
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
    if (request.method === "POST" && url.pathname === "/internal/agent-send") {
      const body = (await request.json().catch(() => null)) as {
        handleHash?: unknown;
        key?: unknown;
        text?: unknown;
        generation?: unknown;
      } | null;
      if (
        !body ||
        typeof body.handleHash !== "string" ||
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
      const { runner } = this.runner(body.handleHash);
      try {
        const result = await runner.sendAgentText({ key: body.key, text: body.text, generation: body.generation });
        if (!result.sent && result.reason === "budget") {
          return Response.json({ sent: false, reason: "budget" }, { status: 429 });
        }
        return Response.json(result);
      } catch (err) {
        this.logger.warn("agent_send_failed", { handle: body.handleHash, err: errName(err) });
        return new Response("Agent send failed.", { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/internal/delete") {
      const body = (await request.json().catch(() => null)) as { handleHash?: unknown } | null;
      if (!body || typeof body.handleHash !== "string") return new Response("Bad delete.", { status: 400 });
      const store = new SqlConversationStore(this.ctx.storage.sql);
      store.wipe(Date.now());
      let filesDeleted = 0;
      if (this.env.FILES) {
        filesDeleted = await new R2FileStore(this.env.FILES).deletePrefix(conversationFilePrefix(body.handleHash));
      }
      await this.ctx.storage.deleteAlarm();
      // Engine and the agent hold the rest of this person's state. Until
      // both confirm, the delete stays pending (see conversation-delete.ts).
      const fresh = newPendingDelete(this.env, body.handleHash, store.meta().generation);
      const { pending, engineRemoved } = await advanceDelete(this.env, fresh);
      if (isDone(pending)) {
        clearPendingDelete(this.ctx.storage.sql);
        this.logger.info("conversation_deleted", { handle: body.handleHash, filesDeleted, engineCleared: true, agentCleared: true });
        return Response.json({ ok: true, filesDeleted, engineRemoved, agentCleared: agentConfigured(this.env) ? true : null });
      }
      const attempts = 1;
      savePendingDelete(this.ctx.storage.sql, { ...pending, attempts, nextAtMs: Date.now() + retryDelayMs(attempts) });
      await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(attempts));
      this.logger.warn("conversation_delete_pending", {
        handle: body.handleHash,
        engineConfirmed: pending.engineDone,
        agentCleared: pending.agentDone,
      });
      return Response.json(
        { ok: false, pending: true, filesDeleted, engineConfirmed: pending.engineDone, agentCleared: pending.agentDone },
        { status: 202 },
      );
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
        engineDeletePending: loadPendingDelete(this.ctx.storage.sql),
      });
    }
    return new Response("Not found.", { status: 404 });
  }

  // Retries a delete that Engine or the agent has not confirmed yet.
  private async retryPendingDelete(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const before = loadPendingDelete(sql);
    if (!before || before.nextAtMs > Date.now()) return;
    const { pending } = await advanceDelete(this.env, before);
    if (isDone(pending)) {
      clearPendingDelete(sql);
      this.logger.info("conversation_delete_confirmed", { handle: pending.handleHash, attempts: before.attempts + 1 });
      return;
    }
    const attempts = before.attempts + 1;
    const nextAtMs = Date.now() + retryDelayMs(attempts);
    savePendingDelete(sql, { ...pending, attempts, nextAtMs });
    this.logger.warn("conversation_delete_pending", { handle: pending.handleHash, attempts });
  }

  async alarm(): Promise<void> {
    await this.retryPendingDelete();
    const stillPending = loadPendingDelete(this.ctx.storage.sql);
    if (stillPending) await this.ctx.storage.setAlarm(stillPending.nextAtMs);
    const { result, retryAfterMs } = await this.runTurnSerialized(this.ctx.id.name ?? this.ctx.id.toString());
    const batchMs = numberEnv(this.env.TURN_BATCH_MS, DEFAULT_RUNNER_CONFIG.batchMs);
    if (result === "retry") {
      await this.ctx.storage.setAlarm(Date.now() + retryAfterMs);
    } else if (result === "waiting" || (result === "ran" && new SqlConversationStore(this.ctx.storage.sql).pending().length > 0)) {
      await this.ctx.storage.setAlarm(Date.now() + batchMs);
    }
  }
}
