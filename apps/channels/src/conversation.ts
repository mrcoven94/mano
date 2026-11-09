// ConversationDO: one Durable Object per handle, keyed by the hashed
// handle. It owns the event log, the outbound state machine and the turn
// runner for exactly one conversation. Internal routes only; the worker
// reaches them from the queue consumer, never from the public internet.
import { Decorations } from "./decorations.js";
import {
  AgentResponder,
  ModelCrisisCheck,
  OpenWeightClient,
  OpenWeightFailed,
  PrimaryBreaker,
  isMetaModelId,
  reportPresentation,
  saveDocumentInEngine,
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
  type OpenWeightAnswer,
  type OpenWeightFallback,
  type OpenWeightOptions,
  type OpenWeightRequest,
  type Responder,
} from "@mano/channels";
import { DEFAULT_MEDIA_HOSTS, DEFAULT_RUNNER_CONFIG, ConversationRunner, type ModelCosts, type SpendLedger } from "./runner.js";

export function parseMediaHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : [...DEFAULT_MEDIA_HOSTS];
}
import { R2FileStore, conversationFilePrefix, imagesConverter, type DocumentStore } from "./files.js";
import { SqlConversationStore } from "./store-sql.js";
import {
  advanceDelete,
  agentConfigured,
  type PendingDelete,
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

  async settle(key: string, actualUsd: number, byModel?: ModelCosts): Promise<void> {
    await this.stub.fetch("https://state/internal/spend-settle", {
      method: "POST",
      body: JSON.stringify({ key, actualUsd, byModel }),
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

// One switch for every reaction and the eyes: on unless set to "false".
export function reactionsEnabled(env: Env): boolean {
  return env.MANO_REACTIONS_ENABLED?.trim().toLowerCase() !== "false";
}

export function buildChannel(env: Env): Channel {
  if (env.BLOOIO_API_KEY && env.BLOOIO_CHANNEL_ID) {
    return new BlooioChannel({ apiKey: env.BLOOIO_API_KEY, channelId: env.BLOOIO_CHANNEL_ID, baseUrl: env.BLOOIO_BASE_URL || undefined });
  }
  return new RecordingChannel();
}

// One breaker per Worker isolate, shared by every conversation and crisis
// check this isolate runs. Not in the global state object: the breaker
// only saves time, since both paths answer, and reading it there would add
// a Durable Object round trip before every model call, the crisis check's
// 3 seconds included. An isolate that never saw the primary fail asks it
// once, finds it down and skips it from then on.
const primaryBreaker = new PrimaryBreaker();

// Meta's open-weight model on zero-retention endpoints, for when the Meta
// Model API is down. It sends real texts outside the Standard model IDs,
// so it stays off until OPENROUTER_API_KEY is set; MANO_OPEN_WEIGHT_MODEL
// names the model and must be a Meta one (AGENTS.md rule 13), never a
// -contributor ID. Off, every reply and crisis check works exactly as
// before.
//
// MANO_MODEL_PROVIDER=modal, with MODAL_ENDPOINT_URL and MODAL_PROXY_TOKEN,
// asks the same model on a Modal Shared Endpoint instead (AGENTS.md rule 7).
// No request carries a pin there: zero retention is Modal's stated policy for
// the endpoint type (November 4 entry in docs/decisions.md). Chosen with a
// setting missing or a URL off Modal's domain, there is no fallback at all. A
// Shared Endpoint serves one model and answers whatever model name it is sent,
// so MANO_OPEN_WEIGHT_MODEL stays as it is, and it ignores the OpenRouter pin in
// the body. It refuses minimal reasoning with a 400, so the fast path and crisis
// check ask for low there.
//
// With OPENROUTER_API_KEY too, OpenRouter is the backup when a Modal call fails
// at run time, on the same model under its pin. Nothing else is ever tried.
export function buildOpenWeight(env: Env, breaker: PrimaryBreaker = primaryBreaker): OpenWeightFallback | undefined {
  const model = env.MANO_OPEN_WEIGHT_MODEL?.trim() ?? "";
  if (!isMetaModelId(model) || model.endsWith("-contributor")) return undefined;
  const modal = env as Env & ModalSettings;
  if (modal.MANO_MODEL_PROVIDER === "modal") {
    const baseUrl = modalBaseUrl(modal.MODAL_ENDPOINT_URL);
    if (!baseUrl || !modal.MODAL_PROXY_TOKEN) return undefined;
    const backup = env.OPENROUTER_API_KEY ? new OpenWeightClient({ apiKey: env.OPENROUTER_API_KEY, model: MODAL_BACKUP_MODEL, fetchFn: noFollow }) : undefined;
    return { client: new ModalOpenWeightClient({ apiKey: modal.MODAL_PROXY_TOKEN, model, baseUrl, fetchFn: noFollow, ...(backup ? { timeoutMs: MODAL_TIMEOUT_WITH_BACKUP_MS } : {}) }, backup), breaker };
  }
  if (!env.OPENROUTER_API_KEY) return undefined;
  return { client: new OpenWeightClient({ apiKey: env.OPENROUTER_API_KEY, model }), breaker };
}

const MODAL_BACKUP_MODEL = "meta/muse-spark-open";
// A redirect must not carry a person's texts to another host. A Worker's fetch
// throws on redirect: "error", so this is "manual": the 3xx comes back as a
// failed call, and is not followed or sent to the backup.
const noFollow: typeof fetch = (input, init) => boundFetch(input, { ...init, redirect: "manual" });
// Short enough to leave the backup time inside a turn.
const MODAL_TIMEOUT_WITH_BACKUP_MS = 30_000;
const SERVER_ERROR = /^http_5\d\d$/;

// A failure of the service, not of this request: a bad token or a refused
// body would fail the same way on the next try, and an abort is the caller's.
function modalDown(reason: string): boolean {
  return reason === "timeout" || reason === "network" || reason === "http_429" || SERVER_ERROR.test(reason);
}

// Which route answered, in fixed words, for the logs that report the model.
function logRoute(route: "modal" | "openrouter"): void {
  console.log(JSON.stringify({ type: "mano_model_route", surface: "text_line", route }));
}

class ModalOpenWeightClient extends OpenWeightClient {
  private backup: OpenWeightClient | undefined;

  constructor(opts: OpenWeightOptions, backup?: OpenWeightClient) {
    super(opts);
    this.backup = backup;
  }

  override async ask(req: OpenWeightRequest, signal?: AbortSignal): Promise<OpenWeightAnswer> {
    let answer: OpenWeightAnswer;
    try {
      answer = await super.ask({ ...req, effort: req.effort === "minimal" ? "low" : req.effort }, signal);
    } catch (err) {
      if (!this.backup || !(err instanceof OpenWeightFailed) || !modalDown(err.reason)) throw err;
      // A 402 here ends as any failed fallback does.
      answer = await this.backup.ask(req, signal);
      logRoute("openrouter");
      return answer;
    }
    logRoute("modal");
    return answer;
  }
}

interface ModalSettings {
  MANO_MODEL_PROVIDER?: string;
  MODAL_ENDPOINT_URL?: string;
  MODAL_PROXY_TOKEN?: string;
}

// The endpoint's API root, or nothing unless it is https on Modal's own
// endpoint domain, so a setting cannot send texts to another host.
function modalBaseUrl(raw: string | undefined): string | undefined {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && url.hostname.endsWith(".modal.direct") ? `${url.origin}/v1` : undefined;
  } catch {
    return undefined;
  }
}

// Real texts go only to a Standard model ID (AGENTS.md rule 7). A
// missing or -contributor ID fails closed to the stand-in, which calls
// no model.
function buildFallbackResponder(env: Env, breaker?: PrimaryBreaker): Responder {
  const model = env.MANO_REPLY_MODEL ?? "";
  if (!env.META_MODEL_API_KEY || !model || model.endsWith("-contributor")) return new StandInResponder();
  const endpoint = buildModelBaseUrl({
    accountId: env.CF_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    provider: env.AI_GATEWAY_PROVIDER,
  });
  return new SparkResponder({
    apiKey: env.META_MODEL_API_KEY,
    model,
    baseUrl: endpoint.url,
    collectLogs: endpoint.via === "direct",
    openWeight: buildOpenWeight(env, breaker),
  });
}

// The model behind the crisis check for one short health question: the
// Standard reply model, store: false, through AI Gateway, with the same
// open-weight fallback as the replies. With no key, or no Standard model
// ID, there is no check, and every such question gets the crisis line
// (fail closed).
export function buildCrisisCheck(env: Env, breaker?: PrimaryBreaker): ModelCrisisCheck | null {
  const model = env.MANO_REPLY_MODEL ?? "";
  if (!env.META_MODEL_API_KEY || !model || model.endsWith("-contributor")) return null;
  const endpoint = buildModelBaseUrl({
    accountId: env.CF_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    provider: env.AI_GATEWAY_PROVIDER,
  });
  return new ModelCrisisCheck({
    apiKey: env.META_MODEL_API_KEY,
    model,
    baseUrl: endpoint.url,
    collectLogs: endpoint.via === "direct",
    openWeight: buildOpenWeight(env, breaker),
  });
}

// Texted photos go to the person's Engine documents. Without Engine
// configured nothing is stored, and the reply says the photo was not
// saved.
export function engineDocuments(env: Env, handleHash: string): DocumentStore | null {
  if (!env.MANO_ENGINE_URL || !env.MANO_ENGINE_CHANNELS_TOKEN || !env.MANO_HANDLE_GRANT_SECRET) return null;
  return {
    put: (doc) =>
      saveDocumentInEngine({
        engineUrl: env.MANO_ENGINE_URL!,
        channelsToken: env.MANO_ENGINE_CHANNELS_TOKEN!,
        grantSecret: env.MANO_HANDLE_GRANT_SECRET!,
        handleHash,
        ...doc,
      }),
  };
}

export function buildResponder(env: Env, handleHash?: string, opts: { agentAllowed?: boolean; breaker?: PrimaryBreaker } = {}): Responder {
  const fallback = buildFallbackResponder(env, opts.breaker);
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
  // Eyes and background removal, outside the turn chain, kept across
  // requests so STOP and a delete can cancel what an earlier one started.
  private decorations: Decorations;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.logger = createLogger();
    this.decorations = new Decorations({
      hold: (work) => ctx.waitUntil(work),
      onError: (name, err) => this.logger.warn("decoration_failed", { name, err: err instanceof Error ? err.name : "unknown" }),
    });
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

  private crisisCheckNoticed = false;

  // Built per request from env; says once per instance when it is off.
  private crisisCheck(): ModelCrisisCheck | null {
    const check = buildCrisisCheck(this.env);
    if (!check && !this.crisisCheckNoticed) {
      this.crisisCheckNoticed = true;
      this.logger.warn("crisis_check_not_live", { detail: "no key or Standard model: every short health question gets the crisis line" });
    }
    return check;
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
      documents: engineDocuments(this.env, handleHash),
      photoConverter: this.env.IMAGES ? imagesConverter(this.env.IMAGES) : null,
      spend: new StateSpendLedger(globalStateStub(this.env)),
      logger: this.logger,
      nowMs: () => Date.now(),
      fetchFn: boundFetch,
      decorations: this.decorations,
      crisisCheck: this.crisisCheck(),
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
        eyesAfterMs: numberEnv(this.env.TURN_EYES_AFTER_MS, DEFAULT_RUNNER_CONFIG.eyesAfterMs),
        reactionsEnabled: reactionsEnabled(this.env),
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
      // The turn's alarm is armed first: it is local, and the batch window
      // starts when the message arrived, not after the route update below.
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
      // Every event with a chat refreshes the chat route, keyed by hash,
      // so handle-less delivery receipts find this conversation later. A
      // failure throws, and the redelivery finds the alarm already armed.
      if (event.chatId) {
        const chat = await hashChatId(event.chatId, this.env.MANO_HANDLE_PEPPER);
        const res = await globalStateStub(this.env).fetch("https://state/internal/route", {
          method: "POST",
          body: JSON.stringify({ chat, handleHash: body.handleHash }),
        });
        await res.body?.cancel();
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
    if (request.method === "POST" && url.pathname === "/internal/agent-send") {
      const body = (await request.json().catch(() => null)) as {
        handleHash?: unknown;
        key?: unknown;
        text?: unknown;
        generation?: unknown;
        noReplay?: unknown;
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
        const result = await runner.sendAgentText({ key: body.key, text: body.text, generation: body.generation, noReplay: body.noReplay === true });
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
      // One synchronous step, before any await: wipe Channels' store and
      // record everything still owed. Until the record is cleared the
      // agent stays off for this handle and the alarm keeps retrying.
      const sql = this.ctx.storage.sql;
      const store = new SqlConversationStore(sql);
      store.wipe(Date.now());
      this.decorations.cancelAll("deleted");
      const intent = { ...newPendingDelete(this.env, body.handleHash, store.meta().generation), nextAtMs: Date.now() };
      savePendingDelete(sql, intent);
      await this.ctx.storage.setAlarm(Date.now() + retryDelayMs(1));
      const { pending, engineRemoved } = await this.advancePendingDelete(intent);
      if (!pending) {
        this.logger.info("conversation_deleted", { handle: body.handleHash, engineCleared: true, agentCleared: true });
        return Response.json({ ok: true, engineRemoved, agentCleared: agentConfigured(this.env) ? true : null });
      }
      return Response.json(
        {
          ok: false,
          pending: true,
          filesDeleted: pending.filesDone,
          engineConfirmed: pending.engineDone,
          agentCleared: pending.agentDone,
        },
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
        engineDeletePending: loadPendingDelete(this.ctx.storage.sql),
      });
    }
    return new Response("Not found.", { status: 404 });
  }

  // Works through a recorded delete once. Clears the record when every
  // part is done; otherwise counts the attempt and schedules the next.
  // Never throws: whatever fails stays in the record for the alarm.
  private async advancePendingDelete(
    before: PendingDelete,
  ): Promise<{ pending: PendingDelete | null; engineRemoved: Record<string, number | boolean> | null }> {
    const sql = this.ctx.storage.sql;
    let result: { pending: PendingDelete; engineRemoved: Record<string, number | boolean> | null };
    try {
      result = await advanceDelete(this.env, before, undefined, async () => {
        if (this.env.FILES) await new R2FileStore(this.env.FILES).deletePrefix(conversationFilePrefix(before.handleHash));
      });
    } catch (err) {
      this.logger.warn("conversation_delete_failed", { handle: before.handleHash, err: errName(err) });
      result = { pending: before, engineRemoved: null };
    }
    if (isDone(result.pending)) {
      clearPendingDelete(sql);
      return { pending: null, engineRemoved: result.engineRemoved };
    }
    const attempts = before.attempts + 1;
    const next = { ...result.pending, attempts, nextAtMs: Date.now() + retryDelayMs(attempts) };
    savePendingDelete(sql, next);
    this.logger.warn("conversation_delete_pending", {
      handle: before.handleHash,
      attempts,
      filesDeleted: next.filesDone,
      engineConfirmed: next.engineDone,
      agentCleared: next.agentDone,
    });
    return { pending: next, engineRemoved: result.engineRemoved };
  }

  // Retries a recorded delete once its next attempt is due.
  private async retryPendingDelete(): Promise<void> {
    const before = loadPendingDelete(this.ctx.storage.sql);
    if (!before || before.nextAtMs > Date.now()) return;
    const { pending } = await this.advancePendingDelete(before);
    if (!pending) this.logger.info("conversation_delete_confirmed", { handle: before.handleHash, attempts: before.attempts + 1 });
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
