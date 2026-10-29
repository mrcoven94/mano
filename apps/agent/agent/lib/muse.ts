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
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { UsageRecorder, startCall, type UsageSink } from "./usage.js";

export const STANDARD_MODEL_ID = "muse-spark-1.3";
export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
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
  recorder: UsageRecorder;
  now: () => number;
}): LanguageModelMiddleware {
  const { modelId, recorder, now } = opts;
  const record = (status: "ok" | "error", inputTokens: number, outputTokens: number, latencyMs: number) =>
    recorder.record({
      package: "agent",
      purpose: "agent-turn",
      provider: "meta",
      model: modelId,
      dataClass: "real",
      inputTokens,
      outputTokens,
      latencyMs,
      status,
    });
  const logUsage = (finishReason: unknown, usage: unknown, latencyMs: number) => {
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
        meta: { ...((params.providerOptions as Record<string, Record<string, unknown>> | undefined)?.meta ?? {}), store: false },
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
      const tap = new TransformStream({
        transform(chunk, controller) {
          const part = chunk as { type?: unknown; finishReason?: unknown; usage?: unknown; error?: unknown };
          if (part?.type === "error") {
            console.log(JSON.stringify({ type: "mano_model_call", model: modelId, status: "stream_error", latencyMs: elapsed() }));
            controller.enqueue({ ...chunk, error: sanitizeModelError(part.error) } as typeof chunk);
            return;
          }
          if (part?.type === "finish") {
            const latencyMs = elapsed();
            const { inputTokens, outputTokens } = logUsage(part.finishReason, part.usage, latencyMs);
            void record("ok", inputTokens, outputTokens, latencyMs);
          }
          controller.enqueue(chunk);
        },
      });
      return { ...result, stream: result.stream.pipeThrough(tap) };
    },
  };
}

export function createMuseModel(opts: MuseModelOptions = {}): { model: LanguageModel; modelId: string } {
  const env = process.env;
  const modelId = STANDARD_MODEL_ID;
  const provider = createOpenAICompatible({
    name: "meta",
    baseURL: opts.baseUrl ?? env.MANO_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: opts.apiKey ?? env.META_MODEL_API_KEY ?? "missing-key",
    includeUsage: true,
  });
  const recorder = new UsageRecorder(opts.usageSink ? [opts.usageSink] : undefined);
  const model = wrapLanguageModel({
    model: provider(modelId),
    middleware: meteringMiddleware({ modelId, recorder, now: opts.now ?? Date.now }),
  });
  return { model, modelId };
}
