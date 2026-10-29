import { buildModelRequest, type KnownEntities } from "./redact.js";
import { RulesChecker } from "./rules.js";
import type { CheckInput, CheckResult, Checker, Verdict, WarmState } from "./types.js";

export const DEFAULT_GUARDIAN_MODEL =
  "RedHatAI/Muse-Glimmer-30B-FP8-block@1deb4641ff84f9a728dd11b27cac1f6a02a9ed14";
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

export interface ProxyAuth {
  keyId: string;
  secret: string;
}

export interface GlimmerCheckerOptions {
  // URL of the guardian check endpoint, posted to as given, for example
  // https://workspace--mano-guardian-check.modal.run.
  url: string;
  // Bearer token checked inside the container.
  token: string;
  // Modal-Key/Modal-Secret pair checked at Modal's proxy before any
  // container wakes. Omit only for local stand-ins.
  proxyAuth?: ProxyAuth;
  // Model record for eval output. The server owns its own model.
  model?: string;
  // Per-check timeout in milliseconds. A timeout is a block.
  timeoutMs?: number;
  // Names and employers to redact before sending.
  knownEntities?: KnownEntities;
  fetchImpl?: typeof fetch;
}

export interface ServerInfo {
  model: { id: string; revision: string };
  image: { tag: string; digest: string };
}

// workerd throws "Illegal invocation" when fetch is called with any
// receiver but the global object, as a stored method call would.
const boundFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function isVerdict(value: unknown): value is Verdict {
  return value === "pass" || value === "fix" || value === "block";
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const model = record["model"];
  const image = record["image"];
  if (typeof model !== "object" || model === null) return false;
  if (typeof image !== "object" || image === null) return false;
  const modelRecord = model as Record<string, unknown>;
  const imageRecord = image as Record<string, unknown>;
  return (
    typeof modelRecord["id"] === "string" &&
    typeof modelRecord["revision"] === "string" &&
    typeof imageRecord["tag"] === "string" &&
    typeof imageRecord["digest"] === "string"
  );
}

function blocked(problem: string): CheckResult {
  return { verdict: "block", problems: [problem] };
}

const UNREADABLE =
  "The safety check answered in a way Mano could not understand, so this action is on hold.";

// Model-backed checker. Runs the local rules first and only asks the model
// when the rules pass. The request carries a redacted copy of the input to
// the check endpoint. Any failure (network, timeout, error status,
// unparsable or invalid answer, contradictory verdict) is a block with a
// message a person can read.
export class GlimmerChecker implements Checker {
  private readonly rules = new RulesChecker();
  private readonly url: string;
  private readonly token: string;
  private readonly proxyAuth: ProxyAuth | null;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly knownEntities: KnownEntities | undefined;
  private readonly fetchImpl: typeof fetch;
  private lastServer: ServerInfo | null = null;

  constructor(options: GlimmerCheckerOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.proxyAuth = options.proxyAuth ?? null;
    this.model = options.model ?? DEFAULT_GUARDIAN_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.knownEntities = options.knownEntities;
    this.fetchImpl = options.fetchImpl ?? boundFetch;
  }

  // Model and image the server reported for its last successful answer, or
  // null when the last check never reached the model. The eval prints this
  // next to its numbers.
  get serverInfo(): ServerInfo | null {
    return this.lastServer;
  }

  get modelRecord(): string {
    return this.model;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.proxyAuth !== null) {
      headers["Modal-Key"] = this.proxyAuth.keyId;
      headers["Modal-Secret"] = this.proxyAuth.secret;
    }
    return headers;
  }

  // Asks the endpoint to start the model and keep it up for about ten
  // minutes, so a check soon after finds it ready. Call it when a
  // conversation starts. "ready" means the model is loaded now, "starting"
  // that it is on its way (a cold start takes minutes), "failed" that the
  // endpoint refused or could not be reached. A failure changes nothing,
  // since a cold check still blocks.
  async warm(): Promise<WarmState> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ warm: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return "failed";
      const body = (await response.json()) as unknown;
      const ready =
        typeof body === "object" &&
        body !== null &&
        (body as Record<string, unknown>)["ready"] === true;
      return ready ? "ready" : "starting";
    } catch {
      return "failed";
    }
  }

  async check(input: CheckInput): Promise<CheckResult> {
    const rules = await this.rules.check(input);
    if (rules.verdict === "block") return rules;
    this.lastServer = null;

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(buildModelRequest(input, this.knownEntities)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return blocked(
          `The safety check timed out after ${Math.round(this.timeoutMs / 1000)} seconds, so this action is on hold. Please try again.`,
        );
      }
      return blocked(
        "The safety check could not be reached, so this action is on hold. Please try again.",
      );
    }

    if (!response.ok) {
      return blocked(
        "The safety check returned an error, so this action is on hold. Please try again.",
      );
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return blocked(UNREADABLE);
    }

    // A duplicated verdict key means the answer is not trustworthy, however
    // JSON parsing would resolve it.
    const verdictKeys = raw.match(/"verdict"\s*:/g) ?? [];
    if (verdictKeys.length !== 1) {
      return blocked(UNREADABLE);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return blocked(UNREADABLE);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return blocked(UNREADABLE);
    }
    const record = parsed as Record<string, unknown>;
    const verdict = record["verdict"];
    const problems = record["problems"];
    if (
      !isVerdict(verdict) ||
      !Array.isArray(problems) ||
      !problems.every((item) => typeof item === "string")
    ) {
      return blocked(UNREADABLE);
    }
    // A pass must have nothing to say, and fix or block must say what is
    // wrong. Anything else contradicts itself.
    if (
      (verdict === "pass" && problems.length > 0) ||
      (verdict !== "pass" && problems.length === 0)
    ) {
      return blocked(
        "The safety check contradicted itself, so this action is on hold. Please try again.",
      );
    }
    if (isServerInfo(parsed)) {
      const parsedRecord = parsed as unknown as ServerInfo;
      this.lastServer = {
        model: { ...parsedRecord.model },
        image: { ...parsedRecord.image },
      };
    }
    return { verdict, problems: [...problems] };
  }
}

// Fail-closed placeholder for broken production config: every action is
// blocked with a message a person can read.
export class MisconfiguredChecker implements Checker {
  async check(_input: CheckInput): Promise<CheckResult> {
    return {
      verdict: "block",
      problems: [
        "The safety check is not set up, so this action is on hold. Mano needs attention before anything can go ahead.",
      ],
    };
  }
}

function isRulesOnly(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// Builds the checker from environment variables. Rules-only is explicit:
// MANO_GUARDIAN_RULES_ONLY=1 returns the local rules checker. Otherwise the
// endpoint must be fully configured (MANO_GUARDIAN_URL plus
// MANO_GUARDIAN_TOKEN); a half-configured endpoint returns a checker that
// blocks everything instead of silently dropping to rules-only.
// MANO_GUARDIAN_KEY_ID and MANO_GUARDIAN_KEY_SECRET carry the proxy pair,
// MANO_GUARDIAN_MODEL records the served model.
export function glimmerCheckerFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Checker {
  if (isRulesOnly(env["MANO_GUARDIAN_RULES_ONLY"])) {
    return new RulesChecker();
  }
  const url = env["MANO_GUARDIAN_URL"]?.trim() ?? "";
  const token = env["MANO_GUARDIAN_TOKEN"]?.trim() ?? "";
  if (url === "" || token === "") {
    return new MisconfiguredChecker();
  }
  const options: GlimmerCheckerOptions = { url, token };
  const keyId = env["MANO_GUARDIAN_KEY_ID"]?.trim() ?? "";
  const keySecret = env["MANO_GUARDIAN_KEY_SECRET"]?.trim() ?? "";
  if (keyId !== "" && keySecret !== "") {
    options.proxyAuth = { keyId, secret: keySecret };
  }
  const model = env["MANO_GUARDIAN_MODEL"]?.trim() ?? "";
  if (model !== "") options.model = model;
  if (fetchImpl !== undefined) options.fetchImpl = fetchImpl;
  return new GlimmerChecker(options);
}
