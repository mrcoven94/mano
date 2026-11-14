// Meta model client. Model IDs come from a fixed allowlist: standard IDs
// for person data, contributor IDs for synthetic data only. The agent
// decides which side a request is on from its own profile record; callers
// never pick.
import { boundFetch } from "./fetch.js";

export const STANDARD_MODEL_IDS = ["muse-spark-1.3"];
export const CONTRIBUTOR_MODEL_IDS = ["muse-spark-1.3-contributor"];
const TRAILING_SLASH = /\/$/;

export interface ModelRequest {
  input: string;
  synthetic: boolean;
  model?: string;
}

export interface CostEntry {
  model: string;
  synthetic: boolean;
  at: string;
  inputChars: number;
}

export interface ModelEndpointOptions {
  accountId?: string;
  gatewayId?: string;
  provider?: string;
  directBaseUrl?: string;
}

export interface ModelClientOptions extends ModelEndpointOptions {
  apiKey: string;
  allowExtra?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

// AI Gateway when the account and gateway are configured, otherwise direct
// to the model API. The caller reports which path is live; both carry the
// same request shape and store:false.
export function buildModelBaseUrl(opts: ModelEndpointOptions): { url: string; via: "ai-gateway" | "direct" } {
  if (opts.accountId && opts.gatewayId) {
    const provider = opts.provider ?? "meta";
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}/${provider}`,
      via: "ai-gateway",
    };
  }
  return { url: (opts.directBaseUrl ?? "https://api.meta.ai/v1").replace(TRAILING_SLASH, ""), via: "direct" };
}

export function defaultModelFor(synthetic: boolean): string {
  return synthetic ? CONTRIBUTOR_MODEL_IDS[0] : STANDARD_MODEL_IDS[0];
}

// Pulls the reply text out of a /responses body: output items of type
// message carry content parts of type output_text.
export function extractOutputText(data: unknown): string {
  const output = (data as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const candidate = part as { type?: unknown; text?: unknown } | null;
      if (candidate?.type === "output_text" && typeof candidate.text === "string") {
        parts.push(candidate.text);
      }
    }
  }
  return parts.join("");
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

// Why a call failed, in fixed words chosen by its status. The provider's
// own text can carry a key, a person's name or a case number, and errors
// reach audits and logs, so it is never repeated.
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

function failed(status: number): string {
  const why = FAILED_BECAUSE[status];
  return `Model request failed: ${status}${why ? ` (${why})` : ""}`;
}

export class MetaModelClient {
  costLog: CostEntry[] = [];
  readonly baseUrl: string;
  readonly via: "ai-gateway" | "direct";
  private apiKey: string;
  private allowlist: Set<string>;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchFn: typeof fetch;

  constructor(opts: ModelClientOptions) {
    if (!opts.apiKey) throw new Error("A model API key is required.");
    this.apiKey = opts.apiKey;
    const endpoint = buildModelBaseUrl(opts);
    this.baseUrl = endpoint.url;
    this.via = endpoint.via;
    this.allowlist = new Set([...STANDARD_MODEL_IDS, ...CONTRIBUTOR_MODEL_IDS, ...(opts.allowExtra ?? [])]);
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchFn = opts.fetchFn ?? boundFetch;
  }

  private isContributorId(id: string): boolean {
    return CONTRIBUTOR_MODEL_IDS.includes(id) || (this.allowlist.has(id) && id.includes("-contributor"));
  }

  resolveModel(synthetic: boolean, requested?: string): string {
    if (requested !== undefined) {
      if (!this.allowlist.has(requested)) throw new Error(`Unknown model ID: ${requested}.`);
      if (!synthetic && this.isContributorId(requested)) {
        throw new Error("Contributor models are only allowed for synthetic data.");
      }
      return requested;
    }
    return defaultModelFor(synthetic);
  }

  async complete(req: ModelRequest): Promise<{ text: string; model: string }> {
    const model = this.resolveModel(req.synthetic, req.model);
    this.costLog.push({ model, synthetic: req.synthetic, at: new Date().toISOString(), inputChars: req.input.length });
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
          body: JSON.stringify({ model, input: req.input, store: false }),
        });
        if (!res.ok) {
          clearTimeout(timer);
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 429 || res.status >= 500) throw new RetryableStatus(res.status);
          throw new ModelFailure(failed(res.status));
        }
        // The timeout stays armed while the body is read.
        let data: unknown;
        try {
          data = await res.json();
        } catch (err) {
          // A timeout mid-body is retried. A parse error quotes the body it
          // could not read, so it is replaced.
          if (isRetryable(err)) throw err;
          throw new ModelFailure(`Model response was not readable: ${res.status}`);
        } finally {
          clearTimeout(timer);
        }
        const status = (data as { status?: unknown })?.status;
        if (typeof status === "string" && status !== "completed") {
          throw new ModelFailure(`Model run ${RUN_STATES.has(status) ? status : "not completed"}.`);
        }
        return { text: extractOutputText(data), model };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < this.maxRetries && isRetryable(err)) {
          await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
          continue;
        }
        throw safeError(err);
      }
    }
    throw safeError(lastErr);
  }
}

// Retries only 429, 5xx and network errors (including timeouts). Every
// other 4xx fails fast, and client errors are never retried.
function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableStatus) return true;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

export interface ModelComplete {
  complete(req: ModelRequest): Promise<{ text: string; model: string }>;
}

// Stand-in used when no API key is configured, so the engine runs
// locally end to end. Its output is labeled and never a real answer.
export class StandInModelClient implements ModelComplete {
  readonly standIn = true;
  costLog: CostEntry[] = [];

  async complete(req: ModelRequest): Promise<{ text: string; model: string }> {
    this.costLog.push({ model: "stand-in", synthetic: req.synthetic, at: new Date().toISOString(), inputChars: req.input.length });
    return {
      text: "[stand-in model: set META_MODEL_API_KEY for live answers] " + req.input.slice(0, 200),
      model: "stand-in",
    };
  }
}

// Engine's chat through OpenRouter, for MANO_MODEL_PROVIDER=openrouter with no
// Meta key: one model from HOSTED_CHAT_MODELS, every request pinned to
// zero-retention endpoints that collect no data, one try, fixed error words.
export const HOSTED_CHAT_MODELS: readonly string[] = Object.freeze([
  "meta/muse-spark-open",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5.5",
  "openai/gpt-6-luna",
  "openai/gpt-6.1-sol",
  "google/gemini-3.8-flash",
]);
const HOSTED_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export class HostedChatClient implements ModelComplete {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchFn: typeof fetch = boundFetch,
    private readonly timeoutMs = 15000,
  ) {
    if (!apiKey) throw new Error("A model API key is required.");
    if (!HOSTED_CHAT_MODELS.includes(model)) throw new Error("Unknown hosted model ID.");
  }

  async complete(req: ModelRequest): Promise<{ text: string; model: string }> {
    let res: Response;
    try {
      res = await this.fetchFn(HOSTED_CHAT_URL, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: req.input }],
          max_tokens: 1024,
          reasoning: { effort: "low", exclude: true },
          provider: { zdr: true, data_collection: "deny" },
        }),
      });
    } catch (err) {
      throw safeError(err);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ModelFailure(failed(res.status));
    }
    const data = (await res.json().catch(() => null)) as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] } | null;
    const choice = data?.choices?.length === 1 ? data.choices[0] : undefined;
    if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") throw new ModelFailure("Model run not completed.");
    return { text: choice.message.content.trim(), model: this.model };
  }
}

// The hosted model this environment chose, or null.
export function hostedChatModel(env: ModelClientEnv): string | null {
  if (env.META_MODEL_API_KEY || env.MANO_MODEL_PROVIDER !== "openrouter" || !env.OPENROUTER_API_KEY) return null;
  const model = env.MANO_AGENT_MODEL?.trim() || "meta/muse-spark-open";
  return HOSTED_CHAT_MODELS.includes(model) ? model : null;
}

export interface ModelClientEnv {
  META_MODEL_API_KEY?: string;
  MANO_MODEL_PROVIDER?: string;
  MANO_AGENT_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_PROVIDER?: string;
  MODEL_ALLOWLIST_EXTRA?: string;
  MANO_ENV?: string;
}

// Test seam: chat() builds its client through createModelClient, and tests
// inject a capturing fake here. Production code never sets it.
let testFactory: ((env: ModelClientEnv) => ModelComplete) | null = null;

export function setModelClientFactoryForTests(factory: ((env: ModelClientEnv) => ModelComplete) | null): void {
  testFactory = factory;
}

export function createModelClient(env: ModelClientEnv, fetchFn?: typeof fetch): ModelComplete {
  if (testFactory) return testFactory(env);
  const hosted = hostedChatModel(env);
  if (hosted) return new HostedChatClient(env.OPENROUTER_API_KEY!, hosted, fetchFn);
  if (!env.META_MODEL_API_KEY) {
    // The stand-in must be an explicit choice: development only. Outside
    // development with no key, fail loud instead of answering from a fake.
    if (env.MANO_ENV !== "development") {
      throw new Error("META_MODEL_API_KEY is not set. Set the key, or MANO_ENV=development for the stand-in.");
    }
    return new StandInModelClient();
  }
  const allowExtra = (env.MODEL_ALLOWLIST_EXTRA ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new MetaModelClient({
    apiKey: env.META_MODEL_API_KEY,
    accountId: env.CF_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID,
    provider: env.AI_GATEWAY_PROVIDER,
    allowExtra,
    fetchFn,
  });
}
