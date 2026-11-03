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

// A deadline (epoch ms) shared by a request and all of its retries, so
// a file's budget bounds the time spent waiting on the model.
export interface CallOptions {
  deadline?: number;
}

export class BudgetExceeded extends Error {
  constructor() {
    super("Model call skipped: the file's time budget is spent.");
    this.name = "BudgetExceeded";
  }
}

export interface ModelClient {
  responses(req: ResponsesRequest, opts?: CallOptions): Promise<ResponsesResult>;
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
    super(failed(status));
    this.name = "RetryableStatus";
    this.status = status;
  }
}

// An error whose words this client chose. Anything else (a transport or
// runtime error) may quote what it was given, so it is replaced.
class ModelFailure extends Error {}

function safeError(err: unknown): Error {
  if (err instanceof ModelFailure || err instanceof RetryableStatus) return err;
  if (err instanceof Error && err.name === "AbortError") return new ModelFailure("Model request timed out.");
  if (err instanceof TypeError) return new ModelFailure("Model request failed: no connection.");
  return new ModelFailure("Model request failed.");
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableStatus) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

// Why a call failed, in fixed words chosen by its status. The provider's
// own text can carry a key, a person's name or a case number, and errors
// reach warnings, so it is never repeated.
const FAILED_BECAUSE: Record<number, string> = {
  400: "the request was not valid",
  401: "the API key was not accepted",
  402: "billing is not set up for this account",
  403: "the API key may not use this model",
  404: "the model was not found",
  413: "the request was too large",
  422: "the request was not valid",
  429: "rate limited",
};
const RUN_STATES = new Set(["failed", "incomplete", "cancelled", "queued", "in_progress"]);
const TRAILING_SLASH = /\/$/;

function failed(status: number): string {
  const why = FAILED_BECAUSE[status];
  return `Model request failed: ${status}${why ? ` (${why})` : ""}`;
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
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(TRAILING_SLASH, "");
    this.allowExtra = new Set(opts.allowExtra ?? []);
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxRetries = opts.maxRetries ?? 2;
    // workerd throws "Illegal invocation" when fetch runs with any
    // receiver but the global, and this.fetchFn(...) passes the client.
    this.fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.synthetic = opts.synthetic ?? false;
  }

  async responses(req: ResponsesRequest, opts: CallOptions = {}): Promise<ResponsesResult> {
    checkModelAllowed(req.model, this.allowExtra);
    if (!this.synthetic && isContributorId(req.model)) {
      throw new Error("Contributor models are only allowed for synthetic data.");
    }
    const body = { ...req, store: false as const };
    let lastErr: unknown;
    const deadline = opts.deadline ?? Infinity;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw attempt === 0 ? new BudgetExceeded() : lastErr;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, remaining));
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
        if (!res.ok) {
          clearTimeout(timer);
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 429 || res.status >= 500) throw new RetryableStatus(res.status);
          throw new ModelFailure(failed(res.status));
        }
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          // A parse error quotes the body it could not read.
          throw new ModelFailure(`Model response was not readable: ${res.status}`);
        } finally {
          clearTimeout(timer);
        }
        const status = (data as { status?: unknown })?.status;
        if (typeof status === "string" && status !== "completed") {
          throw new ModelFailure(`Model run ${RUN_STATES.has(status) ? status : "not completed"}.`);
        }
        return { text: extractOutputText(data), model: req.model, usage: extractUsage(data), raw: data };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        const backoff = 200 * 2 ** attempt;
        if (attempt < this.maxRetries && isRetryable(err) && Date.now() + backoff < deadline) {
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw safeError(err);
      }
    }
    throw safeError(lastErr);
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
// response must record it explicitly. A strict schema the API would
// reject fails the same way the API does.
export interface RecordedEntry {
  match: (req: ResponsesRequest) => boolean;
  result: Omit<ResponsesResult, "model"> & { model?: string };
  // When true, the entry is removed after one use, so a list of entries
  // replays in order like a queue.
  consume?: boolean;
}

// The API's rule for a strict JSON schema: every object sets
// additionalProperties false and lists each of its properties in
// required (an optional field is a required one that allows null). A
// schema that breaks it gets HTTP 400 before any model runs, such as
// "Missing 'score'". Returns every break, empty when the schema is valid.
export function strictSchemaErrors(schema: unknown, path = "schema"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const errors: string[] = [];
  const properties = node["properties"];
  if (typeof properties === "object" && properties !== null) {
    const required = new Set(Array.isArray(node["required"]) ? node["required"] : []);
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) errors.push(`${path}: Missing '${key}' in required`);
    }
    if (node["additionalProperties"] !== false) errors.push(`${path}: additionalProperties must be false`);
    for (const [key, child] of Object.entries(properties)) errors.push(...strictSchemaErrors(child, `${path}.${key}`));
  }
  errors.push(...strictSchemaErrors(node["items"], `${path}[]`));
  if (Array.isArray(node["anyOf"])) node["anyOf"].forEach((child, i) => errors.push(...strictSchemaErrors(child, `${path}.anyOf[${i}]`)));
  return errors;
}

export class RecordedModelClient implements ModelClient {
  readonly live = false;
  calls: ResponsesRequest[] = [];
  callOptions: (CallOptions | undefined)[] = [];
  private entries: RecordedEntry[];

  constructor(entries: RecordedEntry[]) {
    this.entries = entries;
  }

  async responses(req: ResponsesRequest, opts?: CallOptions): Promise<ResponsesResult> {
    this.calls.push(req);
    this.callOptions.push(opts);
    // Refuse what the API refuses, so a schema it would reject fails
    // here too instead of replaying a recorded answer.
    const format = req.text?.format;
    const schemaErrors = format?.strict ? strictSchemaErrors(format.schema) : [];
    if (schemaErrors.length > 0) throw new Error(`Model request failed: 400 (${schemaErrors.join("; ")})`);
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
