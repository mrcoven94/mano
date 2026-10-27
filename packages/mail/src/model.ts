// Small client for the Meta Model API Responses endpoint. The mail
// pipeline only needs responses(request) -> response, so that is the
// whole interface. Two implementations: MetaModelClient for live calls
// and RecordedModelClient, a stand-in that replays recorded responses
// so tests and keyless runs stay deterministic.
//
// Model IDs: real resident content goes only to standard IDs
// (muse-spark-1.3 for reading, sam-3.1 for segmentation). The cheaper
// -contributor ID is allowed only for synthetic data.

export const STANDARD_MODEL = "muse-spark-1.3";
export const CONTRIBUTOR_MODEL = "muse-spark-1.3-contributor";
export const SEGMENT_MODEL = "sam-3.1";

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";

export type ModelContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" };

export interface ModelInputItem {
  role: "system" | "user" | "developer";
  content: ModelContent[];
}

export type ModelInput = string | ModelInputItem[];

export interface JsonSchemaFormat {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesRequest {
  model: string;
  input: ModelInput;
  store?: false;
  text?: { format?: JsonSchemaFormat };
  max_output_tokens?: number;
}

export interface ResponsesResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  raw: unknown;
}

export interface ModelClient {
  responses(req: ResponsesRequest): Promise<ResponsesResult>;
  readonly live: boolean;
}

// Reading model for a run. Synthetic runs may use the contributor ID;
// anything else must use the standard ID.
export function readingModelFor(synthetic: boolean): string {
  return synthetic ? CONTRIBUTOR_MODEL : STANDARD_MODEL;
}

export function isContributorId(id: string): boolean {
  return id === CONTRIBUTOR_MODEL || id.endsWith("-contributor");
}

function checkModelAllowed(model: string, allowExtra: Set<string>): void {
  if (model === STANDARD_MODEL || model === CONTRIBUTOR_MODEL || model === SEGMENT_MODEL) return;
  if (allowExtra.has(model)) return;
  throw new Error(`Unknown model ID: ${model}.`);
}

export function extractOutputText(data: unknown): string {
  if (typeof data === "object" && data !== null && typeof (data as { output_text?: unknown }).output_text === "string") {
    return (data as { output_text: string }).output_text;
  }
  const output = (data as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const candidate = part as { type?: unknown; text?: unknown } | null;
      if (
        (candidate?.type === "output_text" || candidate?.type === "text") &&
        typeof candidate.text === "string"
      ) {
        parts.push(candidate.text);
      }
    }
  }
  return parts.join("");
}

export function extractUsage(data: unknown): ResponsesResult["usage"] {
  const usage = (data as { usage?: unknown } | null)?.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const inputTokens = u["input_tokens"] ?? u["prompt_tokens"];
  const outputTokens = u["output_tokens"] ?? u["completion_tokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return { inputTokens, outputTokens };
}

export interface MetaClientOptions {
  apiKey: string;
  baseUrl?: string;
  allowExtra?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  // Set when the caller constructed this client for synthetic data, so a
  // contributor ID can be used. Default false: contributor IDs rejected.
  synthetic?: boolean;
}

class RetryableStatus extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Model request failed: ${status}`);
    this.name = "RetryableStatus";
    this.status = status;
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableStatus) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

export class MetaModelClient implements ModelClient {
  readonly live = true;
  readonly baseUrl: string;
  private apiKey: string;
  private allowExtra: Set<string>;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchFn: typeof fetch;
  private synthetic: boolean;

  constructor(opts: MetaClientOptions) {
    if (!opts.apiKey) throw new Error("A model API key is required.");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.allowExtra = new Set(opts.allowExtra ?? []);
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.synthetic = opts.synthetic ?? false;
  }

  async responses(req: ResponsesRequest): Promise<ResponsesResult> {
    checkModelAllowed(req.model, this.allowExtra);
    if (!this.synthetic && isContributorId(req.model)) {
      throw new Error("Contributor models are only allowed for synthetic data.");
    }
    const body = { ...req, store: false as const };
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`${this.baseUrl}/responses`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (res.status !== 429 && res.status < 500 && !res.ok) {
          clearTimeout(timer);
          throw new Error(`Model request failed: ${res.status}`);
        }
        const data: unknown = await res.json();
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) throw new RetryableStatus(res.status);
        const status = (data as { status?: unknown })?.status;
        if (typeof status === "string" && status !== "completed") {
          const detail = (data as { error?: { message?: unknown } })?.error?.message;
          throw new Error(`Model run ${status}: ${typeof detail === "string" ? detail : "no detail"}`);
        }
        return { text: extractOutputText(data), model: req.model, usage: extractUsage(data), raw: data };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < this.maxRetries && isRetryable(err)) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
          continue;
        }
        throw err instanceof Error ? err : new Error("Model request failed.");
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Model request failed.");
  }
}

export interface ModelClientEnv {
  META_MODEL_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MODEL_ALLOWLIST_EXTRA?: string;
}

// AI Gateway when account and gateway are configured, otherwise direct
// to the model API.
export function baseUrlFromEnv(env: ModelClientEnv): string {
  if (env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID) {
    const provider = env.AI_GATEWAY_PROVIDER ?? "meta";
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${provider}`;
  }
  return DEFAULT_BASE_URL;
}

export function createModelClient(
  env: ModelClientEnv,
  opts: { synthetic: boolean; fetchFn?: typeof fetch } = { synthetic: false },
): MetaModelClient | RecordedModelClient {
  if (!env.META_MODEL_API_KEY) return new RecordedModelClient([]);
  const allowExtra = (env.MODEL_ALLOWLIST_EXTRA ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new MetaModelClient({
    apiKey: env.META_MODEL_API_KEY,
    baseUrl: baseUrlFromEnv(env),
    allowExtra,
    synthetic: opts.synthetic,
    fetchFn: opts.fetchFn,
  });
}

// Stand-in that replays recorded responses. Matchers pair a predicate on
// the request with the response to return, so tests stay deterministic
// with no key. Unmatched requests fail loudly: a test that needs a new
// response must record it explicitly.
export interface RecordedEntry {
  match: (req: ResponsesRequest) => boolean;
  result: Omit<ResponsesResult, "model"> & { model?: string };
  // When true, the entry is removed after one use, so a list of entries
  // replays in order like a queue.
  consume?: boolean;
}

export class RecordedModelClient implements ModelClient {
  readonly live = false;
  calls: ResponsesRequest[] = [];
  private entries: RecordedEntry[];

  constructor(entries: RecordedEntry[]) {
    this.entries = entries;
  }

  async responses(req: ResponsesRequest): Promise<ResponsesResult> {
    this.calls.push(req);
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.match(req)) {
        if (entry.consume) this.entries.splice(i, 1);
        return { ...entry.result, model: entry.result.model ?? req.model };
      }
    }
    throw new Error(
      `No recorded response for model ${req.model}. Failing closed: record one or run live.`,
    );
  }
}

export function recordedText(text: string): Omit<ResponsesResult, "model"> {
  return { text, usage: null, raw: { recorded: true } };
}
