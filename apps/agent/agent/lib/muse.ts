// The model for the agent's turns, called directly as an AI SDK model
// instance over OpenAI-compatible chat completions. MANO_MODEL_PROVIDER
// picks the route, and production sets it to modal. A middleware layer
// enforces the output cap (Muse reasons, and reasoning tokens count
// against the cap: 600 starved every answer, so this starts at 4096),
// sends the route's fixed body fields (store:false on the Meta Model API),
// logs the run status plus usage on every call, and strips content from
// every error before the runtime sees it.
//
// With no route set, turns go to the Meta Model API. The agent answers a
// public number, so that route always uses the Standard model ID. Nothing
// here reads a data-class setting: no environment value, request, or
// caller can select a cheaper contributor ID.
//
// MANO_MODEL_PROVIDER=openrouter (with OPENROUTER_API_KEY) switches the
// agent to Meta's open-weight model through OpenRouter, pinned to
// zero-retention endpoints that collect no data, the same pin as the text
// line's fallback, sorted by latency and at low reasoning effort. Without
// the key, turns go to the Meta Model API. Filling a form follows the
// same switch (computer-fill.ts), on a client of its own.
//
// MANO_MODEL_PROVIDER=modal (with MODAL_ENDPOINT_URL and MODAL_PROXY_TOKEN)
// switches turns to the same open-weight model on a Modal Shared Endpoint.
// Production runs this route (the November 4 LAP-913 entry in
// docs/decisions.md). Rule 7 allows it on the strength of Modal's stated
// zero retention for this endpoint type (no request carries a pin; see the
// November 4 entry in docs/decisions.md). Chosen with a setting missing or
// a URL off Modal's domain, it calls no model and never falls back to
// another route. Filling a form follows it, on a client of its own.
//
// With OPENROUTER_API_KEY too, OpenRouter is the backup when a Modal call fails
// at run time: only Meta's open-weight model, under the same pin. Nothing else
// is ever tried.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  wrapLanguageModel,
  type JSONValue,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { UsageRecorder, startCall } from "./usage.js";

export const STANDARD_MODEL_ID = "muse-spark-1.3";
export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPEN_WEIGHT_MODEL_ID = "meta/muse-spark-open";
// OpenRouter provider routing: only endpoints with zero data retention,
// and no provider that stores or trains on what it is sent.
const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: "deny" } as const);
// Among those endpoints, the fastest to answer first. Low reasoning
// effort: over greeting, SNAP and YES turns the open model reasoned for
// a median of 245 tokens at its default and 40 at low, and the voice
// evals held. The model cannot turn reasoning off.
const OPENROUTER_BODY = Object.freeze({
  provider: { sort: "latency", ...ZERO_RETENTION },
  reasoning: { effort: "low" },
} as const);
export const MODAL_MODEL_ID = "meta-models/Muse-Spark-Open-816B-A42B";
// Modal has no per-request routing to pin: its security page says Shared
// Endpoints keep no request or response payloads. Low effort cut the median
// reasoning from 453 tokens to 168 over six synthetic turns each.
const MODAL_BODY = Object.freeze({ reasoning: { effort: "low" } } as const);

// The endpoint's API root, or nothing unless it is https on Modal's own
// endpoint domain, so a setting cannot send turns to another host.
function modalBaseUrl(raw: string | undefined): string | undefined {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && url.hostname.endsWith(".modal.direct") ? `${url.origin}/v1` : undefined;
  } catch {
    return undefined;
  }
}

// Reasoning alone burns ~600-1100 tokens on a greeting; 4096 leaves
// room for reasoning plus tool calls plus a short reply.
export const MAX_OUTPUT_TOKENS = 4096;
// Published 1M-token window (1,048,576). Eve needs it explicitly: Meta
// models are not in the AI Gateway catalog it would look this up in.
export const MODEL_CONTEXT_WINDOW_TOKENS = 1_048_576;

const RETRY_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"];

export interface MuseModelOptions {
  apiKey?: string;
}

function tokenCount(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function finishReasonOf(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (typeof reason === "object" && reason !== null && typeof (reason as { unified?: unknown }).unified === "string") {
    return (reason as { unified: string }).unified;
  }
  return "unknown";
}

// Model errors carry the request body (the person's texts and recalled
// memory) and the provider's response, which can echo it. The runtime
// logs errors it receives, so only the status and retry fields survive.
export function sanitizeModelError(err: unknown): Error {
  if (APICallError.isInstance(err)) {
    const headers: Record<string, string> = {};
    for (const name of RETRY_HEADERS) {
      const value = err.responseHeaders?.[name];
      if (typeof value === "string") headers[name] = value;
    }
    let url = "";
    try {
      const parsed = new URL(err.url);
      url = `${parsed.origin}${parsed.pathname}`;
    } catch {
      // An unparseable URL is dropped rather than echoed.
    }
    return new APICallError({
      message: `Model call failed with status ${err.statusCode ?? "unknown"}.`,
      url,
      requestBodyValues: {},
      statusCode: err.statusCode,
      responseHeaders: headers,
      isRetryable: err.isRetryable,
    });
  }
  const safe = new Error("Model call failed.");
  safe.name = err instanceof Error ? err.name : "Error";
  return safe;
}

function meteringMiddleware(opts: {
  modelId: string;
  provider: string;
  bodyExtra: Record<string, JSONValue>;
  recorder: UsageRecorder;
}): LanguageModelMiddleware {
  const { modelId, provider, bodyExtra, recorder } = opts;
  const record = (status: "ok" | "error", inputTokens: number, outputTokens: number, latencyMs: number) =>
    recorder.record({
      package: "agent",
      purpose: "agent-turn",
      provider,
      model: modelId,
      dataClass: "real",
      inputTokens,
      outputTokens,
      latencyMs,
      status,
    });
  const logUsage = (finishReason: unknown, usage: unknown, latencyMs: number, ttftMs?: number) => {
    const u = (usage ?? {}) as { inputTokens?: { total?: number }; outputTokens?: { total?: number; reasoning?: number } };
    const inputTokens = tokenCount(u.inputTokens?.total);
    const outputTokens = tokenCount(u.outputTokens?.total);
    console.log(
      JSON.stringify({
        type: "mano_model_call",
        model: modelId,
        finishReason: finishReasonOf(finishReason),
        inputTokens,
        outputTokens,
        reasoningTokens: tokenCount(u.outputTokens?.reasoning),
        latencyMs,
        ...(ttftMs === undefined ? {} : { ttftMs }),
      }),
    );
    return { inputTokens, outputTokens };
  };
  const failed = async (err: unknown, latencyMs: number): Promise<never> => {
    const safe = sanitizeModelError(err);
    const status = APICallError.isInstance(safe) ? safe.statusCode : undefined;
    console.log(JSON.stringify({ type: "mano_model_call", model: modelId, status: "error", httpStatus: status ?? null, latencyMs }));
    await record("error", 0, 0, latencyMs);
    throw safe;
  };
  return {
    transformParams: async ({ params }) => ({
      ...params,
      maxOutputTokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      providerOptions: {
        ...(params.providerOptions ?? {}),
        [provider]: { ...(params.providerOptions?.[provider] ?? {}), ...bodyExtra },
      },
    }),
    wrapGenerate: async ({ doGenerate }) => {
      const elapsed = startCall();
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        result = await doGenerate();
      } catch (err) {
        return failed(err, elapsed());
      }
      const latencyMs = elapsed();
      const { inputTokens, outputTokens } = logUsage(result.finishReason, result.usage, latencyMs);
      await record("ok", inputTokens, outputTokens, latencyMs);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const elapsed = startCall();
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (err) {
        return failed(err, elapsed());
      }
      // Read the provider stream by hand rather than piping it: a pipe
      // forwards a source rejection untouched, and that error carries
      // the request body. Every chunk and every failure passes here.
      const reader = result.stream.getReader();
      let ttftMs: number | undefined;
      const stream = new ReadableStream<(typeof result.stream extends ReadableStream<infer C> ? C : never)>({
        async pull(controller) {
          let next: Awaited<ReturnType<typeof reader.read>>;
          try {
            next = await reader.read();
          } catch (err) {
            console.log(JSON.stringify({ type: "mano_model_call", model: modelId, status: "stream_error", latencyMs: elapsed() }));
            controller.error(sanitizeModelError(err));
            return;
          }
          if (next.done) {
            controller.close();
            return;
          }
          const chunk = next.value;
          const part = chunk as { type?: unknown; finishReason?: unknown; usage?: unknown; error?: unknown };
          if (part?.type === "error") {
            console.log(JSON.stringify({ type: "mano_model_call", model: modelId, status: "stream_error", latencyMs: elapsed() }));
            controller.enqueue({ ...chunk, error: sanitizeModelError(part.error) } as typeof chunk);
            return;
          }
          if (ttftMs === undefined && typeof part?.type === "string" && part.type.endsWith("-delta")) ttftMs = elapsed();
          if (part?.type === "finish") {
            const latencyMs = elapsed();
            const { inputTokens, outputTokens } = logUsage(part.finishReason, part.usage, latencyMs, ttftMs);
            void record("ok", inputTokens, outputTokens, latencyMs);
          }
          controller.enqueue(chunk);
        },
        cancel(reason) {
          return reader.cancel(reason).catch(() => undefined);
        },
      });
      return { ...result, stream };
    },
  };
}

interface ModelRoute {
  name: "meta" | "openrouter" | "modal";
  baseURL: string;
  // Empty when the chosen route has no key; the agent then runs a stand-in.
  apiKey: string;
  modelId: string;
  bodyExtra: Record<string, JSONValue>;
}

// The one place that picks the model path, for both createMuseModel and
// the agent's stand-in check.
export function selectModelRoute(opts: MuseModelOptions = {}, env: NodeJS.ProcessEnv = process.env): ModelRoute {
  if (env.MANO_MODEL_PROVIDER === "modal") {
    const baseURL = modalBaseUrl(env.MODAL_ENDPOINT_URL);
    // An empty key sends the agent to its stand-in, so an incomplete choice
    // reaches no model rather than the Meta Model API.
    return { name: "modal", baseURL: baseURL ?? "", apiKey: baseURL ? (env.MODAL_PROXY_TOKEN ?? "") : "", modelId: MODAL_MODEL_ID, bodyExtra: MODAL_BODY };
  }
  return env.MANO_MODEL_PROVIDER === "openrouter" && env.OPENROUTER_API_KEY
    ? { name: "openrouter", baseURL: OPENROUTER_BASE_URL, apiKey: env.OPENROUTER_API_KEY, modelId: OPEN_WEIGHT_MODEL_ID, bodyExtra: OPENROUTER_BODY }
    : {
        name: "meta",
        baseURL: env.MANO_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
        apiKey: opts.apiKey ?? env.META_MODEL_API_KEY ?? "",
        modelId: STANDARD_MODEL_ID,
        bodyExtra: { store: false },
      };
}

// On Modal's route a redirect must not carry a person's words to another host.
const refuseRedirects: typeof fetch = (input, init) => globalThis.fetch(input, { ...init, redirect: "error" });

// How long Modal may take to start answering when a backup is waiting. Once a
// response starts, nothing here limits it.
const MODAL_START_LIMIT_MS = 30_000;

class ModalStartTimeout extends Error {
  override name = "ModalStartTimeout";
}

function limitedStart(limitMs: number): typeof fetch {
  return async (input, init) => {
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new ModalStartTimeout()), limitMs);
    try {
      return await refuseRedirects(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit.signal]) : limit.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

// A failure of the service, read after sanitizeModelError: a timeout, a 429, a
// 5xx or a lost connection. A refused request would fail again on the backup
// and an abort is the caller's, so neither falls back.
function serviceDown(err: unknown): boolean {
  if (APICallError.isInstance(err)) return err.statusCode === undefined || err.statusCode === 429 || err.statusCode >= 500;
  return err instanceof Error && (err.name === "ModalStartTimeout" || err.name === "TypeError");
}

// Which route answered a turn, in fixed words, for the logs that report it.
function logRoute(route: "modal" | "openrouter"): void {
  console.log(JSON.stringify({ type: "mano_model_route", surface: "agent", route }));
}

// Eve names a step's model when the step starts, before anyone has answered, so
// a step the backup answered still starts under Modal's name. The one thing it
// keeps from the call is this provider field on step.completed. No gateway is in
// use on this route, so try-trace.ts reads it as this fixed mark.
export const BACKUP_ANSWERED = "mano-route-openrouter";

// Falls back only when a call fails before any of its answer has arrived, so
// a person never gets part of one reply and all of another. A failure of the
// backup, a 402 included, ends the call as any model failure does.
function backupMiddleware(backup: ReturnType<typeof wrapLanguageModel>): LanguageModelMiddleware {
  const marked = <T extends { providerMetadata?: unknown }>(part: T): T => ({
    ...part,
    providerMetadata: { ...(part.providerMetadata as object | undefined), gateway: { generationId: BACKUP_ANSWERED } },
  });
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        const result = await doGenerate();
        logRoute("modal");
        return result;
      } catch (err) {
        if (!serviceDown(err)) throw err;
        const result = await backup.doGenerate(params);
        logRoute("openrouter");
        return marked(result);
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        const result = await doStream();
        logRoute("modal");
        return result;
      } catch (err) {
        if (!serviceDown(err)) throw err;
        const result = await backup.doStream(params);
        logRoute("openrouter");
        type Part = typeof result.stream extends ReadableStream<infer C> ? C : never;
        const stream = result.stream.pipeThrough(
          new TransformStream<Part, Part>({
            transform: (part, controller) => controller.enqueue(part.type === "finish" ? marked(part) : part),
          }),
        );
        return { ...result, stream };
      }
    },
  };
}

export function createMuseModel(opts: MuseModelOptions = {}): { model: LanguageModel; modelId: string } {
  const route = selectModelRoute(opts);
  if (route.name === "modal" && !route.apiKey) throw new Error("Modal is chosen but its settings are incomplete.");
  const recorder = new UsageRecorder();
  const metered = (r: Pick<ModelRoute, "name" | "baseURL" | "apiKey" | "modelId" | "bodyExtra">, fetchFn?: typeof fetch) =>
    wrapLanguageModel({
      model: createOpenAICompatible({ name: r.name, baseURL: r.baseURL, apiKey: r.apiKey || "missing-key", includeUsage: true, ...(fetchFn ? { fetch: fetchFn } : {}) })(r.modelId),
      middleware: meteringMiddleware({ modelId: r.modelId, provider: r.name, bodyExtra: r.bodyExtra, recorder }),
    });
  const backupKey = route.name === "modal" ? process.env.OPENROUTER_API_KEY : undefined;
  if (!backupKey) return { model: metered(route, route.name === "modal" ? refuseRedirects : undefined), modelId: route.modelId };
  const backup = metered({ name: "openrouter", baseURL: OPENROUTER_BASE_URL, apiKey: backupKey, modelId: OPEN_WEIGHT_MODEL_ID, bodyExtra: OPENROUTER_BODY }, refuseRedirects);
  return { model: wrapLanguageModel({ model: metered(route, limitedStart(MODAL_START_LIMIT_MS)), middleware: backupMiddleware(backup) }), modelId: route.modelId };
}
