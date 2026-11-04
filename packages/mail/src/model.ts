// Small client for the Meta Model API Responses endpoint. The mail
// pipeline only needs responses(request) -> response, so that is the
// whole interface. Three implementations: MetaModelClient for live calls,
// OpenWeightModelClient for live calls while the Meta Model API is down,
// and RecordedModelClient, a stand-in that replays recorded responses so
// tests and keyless runs stay deterministic.
//
// Model IDs: real resident content goes only to standard IDs
// (muse-spark-1.3 for reading, sam-3.1 for segmentation), or to Meta's
// open-weight Muse Spark Open on zero-retention endpoints (AGENTS.md rule
// 7). The cheaper -contributor ID is allowed only for synthetic data.

export const STANDARD_MODEL = "muse-spark-1.3";
export const CONTRIBUTOR_MODEL = "muse-spark-1.3-contributor";
export const SEGMENT_MODEL = "sam-3.1";

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";

export const OPEN_WEIGHT_MODEL = "meta/muse-spark-open";
const OPEN_WEIGHT_URL = "https://openrouter.ai/api/v1/chat/completions";
// OpenRouter provider routing: only endpoints with zero data retention,
// and no provider that stores or trains on what it is sent.
const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: "deny" } as const);

// The same open-weight model on a Modal Shared Endpoint, for
// MANO_MODEL_PROVIDER=modal, with OpenRouter as its backup when a call fails at
// run time and OPENROUTER_API_KEY is set. Off unless chosen. Rule 7 allows it on the
// strength of Modal's stated zero retention for this endpoint type; no request
// carries a pin (November 4 entry in docs/decisions.md).
export const MODAL_OPEN_WEIGHT_MODEL = "meta-models/Muse-Spark-Open-816B-A42B";

// Chat completions URL for a Modal endpoint, or nothing unless it is https
// on Modal's own endpoint domain, so a setting cannot send pages elsewhere.
function modalChatUrl(raw: string | undefined): string | undefined {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && url.hostname.endsWith(".modal.direct") ? `${url.origin}/v1/chat/completions` : undefined;
  } catch {
    return undefined;
  }
}

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

// A SAM request on a path that has no SAM. No call was made, and
// segmentFrame falls back on-device with this as the reason.
export class SegmentationSkipped extends Error {
  constructor() {
    super("SAM 3.1 was not called: it runs only on the Meta Model API, and this run reads with Muse Spark Open.");
    this.name = "SegmentationSkipped";
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

// Why a model call failed, in words Mail chose. These reach logs, so
// nothing from a provider's response can ever become one.
export type ModelFailureKind =
  | "bad_request"
  | "auth"
  | "billing"
  | "not_found"
  | "too_large"
  | "rate_limited"
  | "server"
  | "other_status"
  | "unreadable_response"
  | "refused"
  | "no_answer"
  | "not_completed"
  | "timeout"
  | "no_connection"
  | "budget"
  | "other";

const KIND_OF_STATUS: Record<number, ModelFailureKind> = {
  400: "bad_request",
  401: "auth",
  402: "billing",
  403: "auth",
  404: "not_found",
  413: "too_large",
  422: "bad_request",
  429: "rate_limited",
};

function kindOfStatus(status: number): ModelFailureKind {
  return KIND_OF_STATUS[status] ?? (status >= 500 ? "server" : "other_status");
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
// When the model ran, billed says what it cost, so a failed call still
// counts against a file's budget.
export class ModelFailure extends Error {
  readonly billed: { usage: ResponsesResult["usage"]; model: string } | null;
  readonly kind: ModelFailureKind;
  constructor(message: string, kind: ModelFailureKind, billed: ModelFailure["billed"] = null) {
    super(message);
    this.kind = kind;
    this.billed = billed;
  }
}

export function failureKindOf(err: unknown): ModelFailureKind {
  if (err instanceof ModelFailure) return err.kind;
  if (err instanceof RetryableStatus) return kindOfStatus(err.status);
  if (err instanceof BudgetExceeded) return "budget";
  return "other";
}

function safeError(err: unknown): Error {
  if (err instanceof ModelFailure || err instanceof RetryableStatus) return err;
  if (err instanceof Error && err.name === "AbortError") return new ModelFailure("Model request timed out.", "timeout");
  if (err instanceof TypeError) return new ModelFailure("Model request failed: no connection.", "no_connection");
  return new ModelFailure("Model request failed.", "other");
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

interface Transport {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  fetchFn: typeof fetch;
  // Set on Modal's route: a redirect must not carry a person's pages to another host.
  redirect?: RequestRedirect;
}

function transportFrom(opts: { apiKey: string; timeoutMs?: number; maxRetries?: number; fetchFn?: typeof fetch }): Transport {
  if (!opts.apiKey) throw new Error("A model API key is required.");
  return {
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs ?? 60000,
    maxRetries: opts.maxRetries ?? 2,
    // workerd throws "Illegal invocation" when fetch runs with any
    // receiver but the global, and transport.fetchFn(...) passes the object.
    fetchFn: opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init)),
  };
}

// POST one JSON body and return the answer as parsed JSON. Timeouts, 429s
// and 5xxs retry inside the shared deadline; every error is in fixed words.
async function postJson(transport: Transport, url: string, body: unknown, deadline: number = Infinity): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= transport.maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw attempt === 0 ? new BudgetExceeded() : safeError(lastErr);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(transport.timeoutMs, remaining));
    try {
      const res = await transport.fetchFn(url, {
        ...(transport.redirect ? { redirect: transport.redirect } : {}),
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${transport.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        clearTimeout(timer);
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 429 || res.status >= 500) throw new RetryableStatus(res.status);
        throw new ModelFailure(failed(res.status), kindOfStatus(res.status));
      }
      try {
        return await res.json();
      } catch (err) {
        // The body stalled until the timer aborted it. A failure reading a
        // body is not retried, whichever kind it is.
        if (err instanceof Error && err.name === "AbortError") throw new ModelFailure("Model request timed out.", "timeout");
        // A parse error quotes the body it could not read.
        throw new ModelFailure(`Model response was not readable: ${res.status}`, "unreadable_response");
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const backoff = 200 * 2 ** attempt;
      if (attempt < transport.maxRetries && isRetryable(err) && Date.now() + backoff < deadline) {
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw safeError(err);
    }
  }
  throw safeError(lastErr);
}

// A 200 can still carry no answer. Both are service failures, not a bad
// photo, and a refusal's own words are never repeated.
function answerOr(text: string, refused: boolean, billed: ModelFailure["billed"]): string {
  if (refused) throw new ModelFailure("Model refused the request.", "refused", billed);
  if (text.trim() === "") throw new ModelFailure("Model returned no answer.", "no_answer", billed);
  return text;
}

function hasRefusalPart(data: unknown): boolean {
  const output = (data as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    const content = (item as { content?: unknown } | null)?.content;
    return Array.isArray(content) && content.some((part) => (part as { type?: unknown } | null)?.type === "refusal");
  });
}

export class MetaModelClient implements ModelClient {
  readonly live = true;
  readonly baseUrl: string;
  private transport: Transport;
  private allowExtra: Set<string>;
  private synthetic: boolean;

  constructor(opts: MetaClientOptions) {
    this.transport = transportFrom(opts);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(TRAILING_SLASH, "");
    this.allowExtra = new Set(opts.allowExtra ?? []);
    this.synthetic = opts.synthetic ?? false;
  }

  async responses(req: ResponsesRequest, opts: CallOptions = {}): Promise<ResponsesResult> {
    checkModelAllowed(req.model, this.allowExtra);
    if (!this.synthetic && isContributorId(req.model)) {
      throw new Error("Contributor models are only allowed for synthetic data.");
    }
    const data = await postJson(this.transport, `${this.baseUrl}/responses`, { ...req, store: false as const }, opts.deadline);
    const usage = extractUsage(data);
    const billed = { usage, model: req.model };
    const status = (data as { status?: unknown })?.status;
    if (typeof status === "string" && status !== "completed") {
      throw new ModelFailure(`Model run ${RUN_STATES.has(status) ? status : "not completed"}.`, "not_completed", billed);
    }
    return { text: answerOr(extractOutputText(data), hasRefusalPart(data), billed), model: req.model, usage, raw: data };
  }
}

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

interface ChatMessage {
  role: ModelInputItem["role"];
  content: string | ChatPart[];
}

// Everything a request to the open-weight model can carry. Built field by
// field, so nothing on a request reaches the body unmapped, and the model
// and pin are constants no option or setting can change.
interface OpenWeightBody {
  model: typeof OPEN_WEIGHT_MODEL | typeof MODAL_OPEN_WEIGHT_MODEL;
  messages: ChatMessage[];
  max_tokens?: number;
  response_format?: { type: "json_schema"; json_schema: Omit<JsonSchemaFormat, "type"> };
  provider?: typeof ZERO_RETENTION;
}

function chatMessage(item: ModelInputItem): ChatMessage {
  const parts = item.content.map((part): ChatPart =>
    part.type === "input_text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } },
  );
  const [only] = parts;
  return { role: item.role, content: parts.length === 1 && only?.type === "text" ? only.text : parts };
}

function openWeightBody(req: ResponsesRequest, route: OpenWeightRoute): OpenWeightBody {
  const input: ModelInputItem[] = typeof req.input === "string" ? [{ role: "user", content: [{ type: "input_text", text: req.input }] }] : req.input;
  const format = req.text?.format;
  const messages = input.map(chatMessage);
  // OpenRouter prefers endpoints that list response_format, but one that
  // does not can still take the request and ignore it, and two of the
  // zero-retention endpoints do not list it. The words keep those answers
  // readable; readPage's parser and retry handle the rest.
  if (format) messages.unshift({ role: "system", content: `Answer with one JSON object and nothing else, matching this JSON schema: ${JSON.stringify(format.schema)}` });
  return {
    model: route.model,
    messages,
    ...(req.max_output_tokens === undefined ? {} : { max_tokens: req.max_output_tokens }),
    ...(format ? { response_format: { type: "json_schema" as const, json_schema: { name: format.name, schema: format.schema, ...(format.strict === undefined ? {} : { strict: format.strict }) } } } : {}),
    ...route.pin,
  };
}

// The text of exactly one choice that finished on its own: a reading cut
// off at the token cap is not a reading, even if it parses.
function openWeightText(data: unknown, billed: ModelFailure["billed"]): string {
  const choices = (data as { choices?: unknown } | null)?.choices;
  const choice = (Array.isArray(choices) && choices.length === 1 ? choices[0] : null) as { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } } | null;
  const message = choice?.message;
  const refused = typeof message?.refusal === "string" && message.refusal.trim() !== "";
  if (!choice || (choice.finish_reason !== "stop" && !refused)) throw new ModelFailure("Model run not completed.", "not_completed", billed);
  return answerOr(typeof message?.content === "string" ? message.content : "", refused, billed);
}

interface OpenWeightRoute {
  url: string;
  model: OpenWeightBody["model"];
  pin: Pick<OpenWeightBody, "provider">;
}

const OPENROUTER_ROUTE: OpenWeightRoute = { url: OPEN_WEIGHT_URL, model: OPEN_WEIGHT_MODEL, pin: { provider: ZERO_RETENTION } };

export interface OpenWeightClientOptions {
  apiKey: string;
  // A Modal endpoint's URL, with apiKey as its proxy token. Without one,
  // OpenRouter. Anything off Modal's domain is refused.
  modalUrl?: string;
  // OpenRouter's key, to read there when a Modal call fails at run time.
  backupApiKey?: string | undefined;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

// Meta's open-weight model through OpenRouter, while the Meta Model API
// cannot answer. It takes Mail's reading requests only and answers them
// all with the one model. There is no model option and the only URL option
// is held to Modal's domain, so rule 13's Meta-only limit and the OpenRouter
// pin hold whatever the settings say.
const MODAL_TIMEOUT_WITH_BACKUP_MS = 30_000;
// A failure of the service. A refused request would fail again on the backup,
// and a spent budget has no time for it.
const SERVICE_DOWN = new Set<ModelFailureKind>(["timeout", "rate_limited", "server", "no_connection"]);

// Which route answered a read, in fixed words, for the logs that report it.
function logRoute(route: "modal" | "openrouter"): void {
  console.log(JSON.stringify({ type: "mano_model_route", surface: "mail", route }));
}

export class OpenWeightModelClient implements ModelClient {
  readonly live = true;
  private transport: Transport;
  private route: OpenWeightRoute;
  private backup: OpenWeightModelClient | null = null;

  constructor(opts: OpenWeightClientOptions) {
    this.transport = transportFrom(opts);
    if (opts.modalUrl === undefined) {
      this.route = OPENROUTER_ROUTE;
      return;
    }
    const url = modalChatUrl(opts.modalUrl);
    if (!url) throw new Error("A Modal endpoint URL must be https on Modal's own domain.");
    this.route = { url, model: MODAL_OPEN_WEIGHT_MODEL, pin: {} };
    this.transport = { ...this.transport, redirect: "error" };
    if (opts.backupApiKey) {
      this.backup = new OpenWeightModelClient({ apiKey: opts.backupApiKey, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
      this.backup.transport = { ...this.backup.transport, redirect: "error" };
      // One short try, so the backup has time inside the file's budget.
      this.transport = { ...this.transport, timeoutMs: MODAL_TIMEOUT_WITH_BACKUP_MS, maxRetries: 0 };
    }
  }

  async responses(req: ResponsesRequest, opts: CallOptions = {}): Promise<ResponsesResult> {
    if (req.model === SEGMENT_MODEL) throw new SegmentationSkipped();
    if (req.model !== STANDARD_MODEL && req.model !== CONTRIBUTOR_MODEL) throw new Error(`Unknown model ID: ${req.model}.`);
    const { model } = this.route;
    let data: unknown;
    try {
      data = await postJson(this.transport, this.route.url, openWeightBody(req, this.route), opts.deadline);
    } catch (err) {
      if (!this.backup || !SERVICE_DOWN.has(failureKindOf(err))) throw err;
      // A failure here, a 402 included, ends the read as any model failure does.
      const answer = await this.backup.responses(req, opts);
      logRoute("openrouter");
      return answer;
    }
    if (this.backup) logRoute("modal");
    const usage = extractUsage(data);
    return { text: openWeightText(data, { usage, model }), model, usage, raw: data };
  }
}

export interface ModelClientEnv {
  META_MODEL_API_KEY?: string;
  MANO_MODEL_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  MODAL_ENDPOINT_URL?: string;
  MODAL_PROXY_TOKEN?: string;
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
): MetaModelClient | OpenWeightModelClient | RecordedModelClient {
  // Chosen with a setting missing or a URL off Modal's domain, it reads with
  // the stand-in, which answers nothing, rather than the Meta Model API.
  if (env.MANO_MODEL_PROVIDER === "modal") {
    if (!env.MODAL_PROXY_TOKEN || !modalChatUrl(env.MODAL_ENDPOINT_URL)) return new RecordedModelClient([]);
    return new OpenWeightModelClient({ apiKey: env.MODAL_PROXY_TOKEN, modalUrl: env.MODAL_ENDPOINT_URL, backupApiKey: env.OPENROUTER_API_KEY, fetchFn: opts.fetchFn });
  }
  if (env.MANO_MODEL_PROVIDER === "openrouter" && env.OPENROUTER_API_KEY) {
    return new OpenWeightModelClient({ apiKey: env.OPENROUTER_API_KEY, fetchFn: opts.fetchFn });
  }
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
