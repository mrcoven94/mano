// Muse through the Meta Model API, called directly as an AI SDK model
// instance over OpenAI-compatible chat completions. A middleware layer
// enforces the output cap (Muse reasons, and reasoning tokens count
// against the cap: 600 starved every answer, so this starts at 4096),
// sends store:false, logs the run status plus usage on every call, and
// strips content from every error before the runtime sees it.
//
// The agent answers a public number, so it always uses the Standard
// model ID. Nothing here reads a data-class setting: no environment
// value, request, or caller can select a cheaper contributor ID.
//
// MANO_MODEL_PROVIDER=openrouter (with OPENROUTER_API_KEY) switches the
// agent to Meta's open-weight model through OpenRouter, pinned to
// zero-retention endpoints that collect no data, the same pin as the text
// line's fallback, sorted by latency and at low reasoning effort. It is
// for testing while the Meta Model API is down.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  wrapLanguageModel,
  type JSONValue,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { UsageRecorder, startCall, type UsageSink } from "./usage.js";

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
// Reasoning alone burns ~600-1100 tokens on a greeting; 4096 leaves
// room for reasoning plus tool calls plus a short reply.
export const MAX_OUTPUT_TOKENS = 4096;
// Published 1M-token window (1,048,576). Eve needs it explicitly: Meta
// models are not in the AI Gateway catalog it would look this up in.
export const MODEL_CONTEXT_WINDOW_TOKENS = 1_048_576;

const RETRY_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"];

export interface MuseModelOptions {
  baseUrl?: string;
  apiKey?: string;
  // Test seam: captures usage records instead of logging them.
  usageSink?: UsageSink;
  now?: () => number;
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
  now: () => number;
}): LanguageModelMiddleware {
  const { modelId, provider, bodyExtra, recorder, now } = opts;
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
      const elapsed = startCall(now);
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
      const elapsed = startCall(now);
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
  name: "meta" | "openrouter";
  baseURL: string;
  // Empty when the chosen route has no key; the agent then runs a stand-in.
  apiKey: string;
  modelId: string;
  bodyExtra: Record<string, JSONValue>;
}

// The one place that picks the model path, for both createMuseModel and
// the agent's stand-in check.
export function selectModelRoute(opts: Pick<MuseModelOptions, "baseUrl" | "apiKey"> = {}): ModelRoute {
  const env = process.env;
  return env.MANO_MODEL_PROVIDER === "openrouter" && env.OPENROUTER_API_KEY
    ? { name: "openrouter", baseURL: OPENROUTER_BASE_URL, apiKey: env.OPENROUTER_API_KEY, modelId: OPEN_WEIGHT_MODEL_ID, bodyExtra: OPENROUTER_BODY }
    : {
        name: "meta",
        baseURL: opts.baseUrl ?? env.MANO_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
        apiKey: opts.apiKey ?? env.META_MODEL_API_KEY ?? "",
        modelId: STANDARD_MODEL_ID,
        bodyExtra: { store: false },
      };
}

export function createMuseModel(opts: MuseModelOptions = {}): { model: LanguageModel; modelId: string } {
  const route = selectModelRoute(opts);
  const provider = createOpenAICompatible({
    name: route.name,
    baseURL: route.baseURL,
    apiKey: route.apiKey || "missing-key",
    includeUsage: true,
  });
  const recorder = new UsageRecorder(opts.usageSink ? [opts.usageSink] : undefined);
  const model = wrapLanguageModel({
    model: provider(route.modelId),
    middleware: meteringMiddleware({ modelId: route.modelId, provider: route.name, bodyExtra: route.bodyExtra, recorder, now: opts.now ?? Date.now }),
  });
  return { model, modelId: route.modelId };
}
