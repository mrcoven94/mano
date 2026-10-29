// Muse through the Meta Model API, called directly as an AI SDK model
// instance over OpenAI-compatible chat completions. A middleware layer
// enforces the output cap (Muse reasons, and reasoning tokens count
// against the cap: 600 starved every answer, so this starts at 4096),
// sends store:false, and logs the run status plus usage on every call,
// including a content-free usage record in Meter's shape.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { UsageRecorder, startCall, type DataClass, type UsageSink } from "./usage.js";

export const STANDARD_MODEL_ID = "muse-spark-1.3";
export const CONTRIBUTOR_MODEL_ID = "muse-spark-1.3-contributor";
export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
// Reasoning alone burns ~600-1100 tokens on a greeting; 4096 leaves
// room for reasoning plus tool calls plus a short reply.
export const MAX_OUTPUT_TOKENS = 4096;
// Published 1M-token window (1,048,576). Eve needs it explicitly: Meta
// models are not in the AI Gateway catalog it would look this up in.
export const MODEL_CONTEXT_WINDOW_TOKENS = 1_048_576;

export interface MuseModelOptions {
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
  dataClass?: DataClass;
  // Test seam: captures usage records instead of logging them.
  usageSink?: UsageSink;
  now?: () => number;
}

export function dataClassFromEnv(env: NodeJS.ProcessEnv = process.env): DataClass {
  return env.MANO_DATA_CLASS === "synthetic" ? "synthetic" : "real";
}

export function modelIdForDataClass(dataClass: DataClass): string {
  return dataClass === "synthetic" ? CONTRIBUTOR_MODEL_ID : STANDARD_MODEL_ID;
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

function meteringMiddleware(opts: {
  modelId: string;
  dataClass: DataClass;
  recorder: UsageRecorder;
  now: () => number;
}): LanguageModelMiddleware {
  const { modelId, dataClass, recorder, now } = opts;
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
      try {
        const result = await doGenerate();
        const inputTokens = tokenCount(result.usage.inputTokens.total);
        const outputTokens = tokenCount(result.usage.outputTokens.total);
        const reasoningTokens = tokenCount(result.usage.outputTokens.reasoning);
        const latencyMs = elapsed();
        console.log(
          JSON.stringify({
            type: "mano_model_call",
            model: modelId,
            finishReason: finishReasonOf(result.finishReason),
            inputTokens,
            outputTokens,
            reasoningTokens,
            latencyMs,
          }),
        );
        await recorder.record({
          package: "agent",
          purpose: "agent-turn",
          provider: "meta",
          model: modelId,
          dataClass,
          inputTokens,
          outputTokens,
          latencyMs,
          status: "ok",
        });
        return result;
      } catch (err) {
        const latencyMs = elapsed();
        console.log(JSON.stringify({ type: "mano_model_call", model: modelId, status: "error", latencyMs }));
        await recorder.record({
          package: "agent",
          purpose: "agent-turn",
          provider: "meta",
          model: modelId,
          dataClass,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs,
          status: "error",
        });
        throw err;
      }
    },
    wrapStream: async ({ doStream }) => {
      const elapsed = startCall(now);
      try {
        const result = await doStream();
        const tap = new TransformStream({
          transform(chunk, controller) {
            const part = chunk as { type?: unknown; finishReason?: unknown; usage?: unknown };
            if (part?.type === "finish") {
              const usage = (part.usage ?? {}) as {
                inputTokens?: { total?: number };
                outputTokens?: { total?: number; reasoning?: number };
              };
              const inputTokens = tokenCount(usage.inputTokens?.total);
              const outputTokens = tokenCount(usage.outputTokens?.total);
              const reasoningTokens = tokenCount(usage.outputTokens?.reasoning);
              const latencyMs = elapsed();
              console.log(
                JSON.stringify({
                  type: "mano_model_call",
                  model: modelId,
                  finishReason: finishReasonOf(part.finishReason),
                  inputTokens,
                  outputTokens,
                  reasoningTokens,
                  latencyMs,
                }),
              );
              void recorder.record({
                package: "agent",
                purpose: "agent-turn",
                provider: "meta",
                model: modelId,
                dataClass,
                inputTokens,
                outputTokens,
                latencyMs,
                status: "ok",
              });
            }
            controller.enqueue(chunk);
          },
        });
        return { ...result, stream: result.stream.pipeThrough(tap) };
      } catch (err) {
        const latencyMs = elapsed();
        console.log(JSON.stringify({ type: "mano_model_call", model: modelId, status: "error", latencyMs }));
        await recorder.record({
          package: "agent",
          purpose: "agent-turn",
          provider: "meta",
          model: modelId,
          dataClass,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs,
          status: "error",
        });
        throw err;
      }
    },
  };
}

export function createMuseModel(opts: MuseModelOptions = {}): { model: LanguageModel; modelId: string; dataClass: DataClass } {
  const env = process.env;
  const dataClass = opts.dataClass ?? dataClassFromEnv(env);
  const modelId = opts.modelId ?? modelIdForDataClass(dataClass);
  const provider = createOpenAICompatible({
    name: "meta",
    baseURL: opts.baseUrl ?? env.MANO_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: opts.apiKey ?? env.META_MODEL_API_KEY ?? "missing-key",
    includeUsage: true,
  });
  const recorder = new UsageRecorder(opts.usageSink ? [opts.usageSink] : undefined);
  const model = wrapLanguageModel({
    model: provider(modelId),
    middleware: meteringMiddleware({ modelId, dataClass, recorder, now: opts.now ?? Date.now }),
  });
  return { model, modelId, dataClass };
}
