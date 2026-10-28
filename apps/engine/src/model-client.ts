// Meta model client. Model IDs come from a fixed allowlist: standard IDs
// for person data, contributor IDs for synthetic data only. The agent
// decides which side a request is on from its own profile record; callers
// never pick.

export const STANDARD_MODEL_IDS = ["muse-spark-1.3"];
export const CONTRIBUTOR_MODEL_IDS = ["muse-spark-1.3-contributor"];

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
  return { url: (opts.directBaseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, ""), via: "direct" };
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
    super(`Model request failed: ${status}`);
    this.name = "RetryableStatus";
    this.status = status;
  }
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
    this.fetchFn = opts.fetchFn ?? fetch;
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
        if (res.status !== 429 && res.status < 500 && !res.ok) {
          clearTimeout(timer);
          throw new Error(`Model request failed: ${res.status}`);
        }
        // The timeout stays armed while the body is read.
        const data: unknown = await res.json();
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) throw new RetryableStatus(res.status);
        const status = (data as { status?: unknown })?.status;
        if (typeof status === "string" && status !== "completed") {
          const detail = (data as { error?: { message?: unknown } })?.error?.message;
          throw new Error(`Model run ${status}: ${typeof detail === "string" ? detail : "no detail"}`);
        }
        return { text: extractOutputText(data), model };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < this.maxRetries && isRetryable(err)) {
          await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
          continue;
        }
        throw err instanceof Error ? err : new Error("Model request failed.");
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Model request failed.");
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

export interface ModelClientEnv {
  META_MODEL_API_KEY?: string;
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
