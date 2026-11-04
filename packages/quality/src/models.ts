// Model client. Production uses Meta endpoints through config; without a key
// the fake client answers deterministically and the report says so. Real
// resident content only ever goes to Standard model IDs with store disabled.
//
// MANO_MODEL_PROVIDER=openrouter (with OPENROUTER_API_KEY) moves the judge and
// the letters' answers to Meta's open-weight models through OpenRouter, the
// same switch as the agent's (apps/agent/agent/lib/muse.ts), for synthetic
// bench runs while the Meta Model API is down. The text line stays on its own
// client.

import { isMetaModelId } from "@mano/channels";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelClient {
  id: string;
  live: boolean;
  complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<ChatResult>;
}

interface ChatCompletionsBody {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class MetaModelClient implements ModelClient {
  readonly live = true;
  readonly id: string;
  private baseUrl: string;
  private apiKey: string;

  private fetchFn: typeof fetch;

  constructor(modelId: string, baseUrl: string, apiKey: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
    this.id = modelId;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<ChatResult> {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(viaAiGateway(this.baseUrl) ? { "cf-aig-collect-log": "false" } : {}),
      },
      body: JSON.stringify({ model: this.id, messages, store: false, max_tokens: opts?.maxTokens ?? 8192 }),
    });
    if (!res.ok) throw new Error(`model call failed: ${res.status}`);
    const body = (await res.json()) as ChatCompletionsBody;
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPEN_WEIGHT_MODEL_ID = "meta/muse-spark-open";
// The judge never shares the writer's model, and of the Muse models only
// these two have zero-retention endpoints on OpenRouter.
export const OPEN_WEIGHT_JUDGE_ID = "meta/muse-glimmer-30b";
// OpenRouter provider routing: only endpoints with zero data retention, and
// no provider that stores or trains on what it is sent.
const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: "deny" } as const);

export function openRouterKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.MANO_MODEL_PROVIDER === "openrouter" && env.OPENROUTER_API_KEY ? env.OPENROUTER_API_KEY : null;
}

export interface OpenRouterCompleteOptions {
  maxTokens?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

export class OpenRouterModelClient implements ModelClient {
  readonly live = true;
  readonly id: string;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(modelId: string, apiKey: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
    if (!isMetaModelId(modelId)) throw new Error(`only Meta models run, not ${modelId}`);
    this.id = modelId;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async complete(messages: ChatMessage[], opts?: OpenRouterCompleteOptions): Promise<ChatResult> {
    const res = await this.fetchFn(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.id,
        messages,
        max_tokens: opts?.maxTokens ?? 8192,
        provider: ZERO_RETENTION,
        ...(opts?.jsonSchema ? { response_format: { type: "json_schema", json_schema: opts.jsonSchema } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`model call failed: ${res.status}`);
    const body = (await res.json()) as ChatCompletionsBody;
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

// Deterministic stand-in. The handler decides the reply from the prompt so
// tests control exactly what the fake model says.
export class FakeModelClient implements ModelClient {
  readonly live = false;
  readonly id = "fake-model-client";
  private handler: (messages: ChatMessage[]) => string;

  constructor(handler?: (messages: ChatMessage[]) => string) {
    this.handler = handler ?? (() => "{}");
  }

  async complete(messages: ChatMessage[]): Promise<ChatResult> {
    const text = this.handler(messages);
    return { text, inputTokens: 10, outputTokens: 10 };
  }
}

// AI Gateway logs every request, prompts and replies included, unless the
// request opts out with cf-aig-collect-log: false, which skips the whole
// log entry (developers.cloudflare.com/ai-gateway/observability/logging).
// Every quality call through the Gateway opts out.
export function viaAiGateway(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "gateway.ai.cloudflare.com";
  } catch {
    return false;
  }
}

export const DEFAULT_JUDGE_MODEL_ID = "muse-spark-1.3";
export const DEFAULT_MODEL_BASE_URL = "https://api.meta.ai/v1";

// The judge must never be the same model that wrote the answers. Both IDs
// come from config; CI sets them as plain workflow variables and fails when
// they match. The default judge ID counts, so an explicit serving ID equal to
// the default is also rejected.
export function assertJudgeServingDiffer(env: NodeJS.ProcessEnv = process.env): void {
  const judge = judgeModelId(env);
  const serving = openRouterKey(env) ? OPEN_WEIGHT_MODEL_ID : (env.MANO_MODEL_BENCH_ID ?? "");
  if (serving && judge === serving) {
    throw new Error(`judge model ID must differ from the serving model ID (both ${judge})`);
  }
}

function judgeModelId(env: NodeJS.ProcessEnv): string {
  return env.MANO_MODEL_JUDGE_ID || (openRouterKey(env) ? OPEN_WEIGHT_JUDGE_ID : DEFAULT_JUDGE_MODEL_ID);
}

// The judge runs on a Standard ID, never a -contributor one, whatever the
// configuration says.
export function judgeClientFromEnv(env: NodeJS.ProcessEnv = process.env): ModelClient {
  const key = env.META_MODEL_API_KEY ?? "";
  const base = env.MANO_MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL;
  const id = judgeModelId(env);
  if (/-contributor$/i.test(id)) throw new Error("the judge must run on a Standard model ID, not a -contributor one");
  const openRouter = openRouterKey(env);
  if (openRouter) return new OpenRouterModelClient(id, openRouter);
  if (key) return new MetaModelClient(id, base, key);
  return new FakeModelClient();
}

// Counts only rough tokens for cost math when the API reports none.
export function roughTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
