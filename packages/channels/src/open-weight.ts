// The text line's fallback when the Meta Model API cannot answer: Meta's
// open-weight model through OpenRouter's OpenAI-compatible chat API. Every
// request is pinned to zero-retention endpoints that collect no data. The
// body is built in one place below, with the pin as a frozen constant and
// no option to change it, so this package cannot send a request without
// it. Only Meta model IDs are accepted (AGENTS.md rule 13).
import { boundFetch } from "./fetch.js";
import type { ModelMessage, ReasoningEffort } from "./responder.js";

export const OPEN_WEIGHT_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter provider routing: only endpoints with zero data retention,
// and no provider that stores or trains on what it is sent.
const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: "deny" } as const);

// How long the primary is skipped once a reply call found it down.
export const PRIMARY_SKIP_MS = 5 * 60 * 1000;

const META_MODEL_ID_RE = /^meta(?:-llama)?\/[a-z0-9]/i;
const TRAILING_SLASH_RE = /\/$/;

export function isMetaModelId(model: string): boolean {
  return META_MODEL_ID_RE.test(model);
}

// The Meta Model API is down for a call when it answers 402 (billing) or
// a 5xx. A bad key, a bad request or a rate limit is ours to fix, so it
// gets no fallback.
export function primaryDownStatus(status: number): boolean {
  return status === 402 || status >= 500;
}

export interface OpenWeightRequest {
  instructions: string;
  input: ModelMessage[];
  maxTokens: number;
  effort: ReasoningEffort;
}

interface OpenWeightBody {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens: number;
  reasoning: { effort: ReasoningEffort; exclude: true };
  provider: typeof ZERO_RETENTION;
}

function openWeightBody(model: string, req: OpenWeightRequest): OpenWeightBody {
  return {
    model,
    messages: [{ role: "system", content: req.instructions }, ...req.input],
    max_tokens: req.maxTokens,
    reasoning: { effort: req.effort, exclude: true },
    provider: ZERO_RETENTION,
  };
}

// Complete only for exactly one choice that finished on its own ("stop")
// with an assistant message whose content is text.
export interface OpenWeightAnswer {
  text: string;
  complete: boolean;
}

function readAnswer(data: unknown): OpenWeightAnswer {
  const choices = isRecord(data) && Array.isArray(data.choices) ? data.choices : [];
  const choice: unknown = choices.length === 1 ? choices[0] : null;
  if (!isRecord(choice) || choice.finish_reason !== "stop") return { text: "", complete: false };
  const message = choice.message;
  if (!isRecord(message) || message.role !== "assistant" || typeof message.content !== "string") return { text: "", complete: false };
  return { text: message.content.trim(), complete: true };
}

// The reason is a safe machine string (http status, timeout, network),
// never provider text.
export class OpenWeightFailed extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Open-weight request failed: ${reason}`);
    this.name = "OpenWeightFailed";
    this.reason = reason;
  }
}

export interface OpenWeightOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class OpenWeightClient {
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(opts: OpenWeightOptions) {
    if (!opts.apiKey) throw new Error("An open-weight API key is required.");
    if (!isMetaModelId(opts.model)) throw new Error("The fallback runs on a Meta model ID only.");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? OPEN_WEIGHT_BASE_URL).replace(TRAILING_SLASH_RE, "");
    this.timeoutMs = opts.timeoutMs ?? 90000;
    this.fetchFn = opts.fetchFn ?? boundFetch;
  }

  // One request, never retried or hedged.
  async ask(req: OpenWeightRequest, signal?: AbortSignal): Promise<OpenWeightAnswer> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(openWeightBody(this.model, req)),
      });
    } catch {
      throw new OpenWeightFailed(signal?.aborted ? "aborted" : timeout.aborted ? "timeout" : "network");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new OpenWeightFailed(`http_${res.status}`);
    }
    return readAnswer(await res.json().catch(() => null));
  }
}

// Remembers that a reply call found the Meta Model API down, so calls in
// the next few minutes go straight to the fallback instead of waiting on
// it. Nothing is stored: a new instance asks the primary first, and both
// paths answer, so a lost trip costs one slow call, never a wrong reply.
export class PrimaryBreaker {
  private skipUntilMs = 0;
  private skipMs: number;
  private nowMs: () => number;

  constructor(skipMs: number = PRIMARY_SKIP_MS, nowMs: () => number = () => Date.now()) {
    this.skipMs = skipMs;
    this.nowMs = nowMs;
  }

  skipPrimary(): boolean {
    return this.nowMs() < this.skipUntilMs;
  }

  trip(): void {
    this.skipUntilMs = this.nowMs() + this.skipMs;
  }
}

export interface OpenWeightFallback {
  client: OpenWeightClient;
  breaker: PrimaryBreaker;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
