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

// Guardian scales to zero, and a cold start takes minutes. Modal answers
// 503 while no container is up, and a check can also time out while one
// starts. An immediate retry would find it cold again.
const STARTING = 503;
const COLD =
  "The safety check is taking longer than usual, so this action is on hold. Please try again in a few minutes.";

const UNREADABLE =
  "The safety check answered in a way Mano could not understand, so this action is on hold.";

// What Guardian receives: the action as Mano would send it, every value as
// written, with the sources it cites, the consents on record and who
// asked for it. Nothing is removed or relabeled, so nothing can hide an
// attack from Guardian (docs/decisions.md, November 3, 2026).
function modelRequest(input: CheckInput): CheckInput {
  const { type, recipient, purpose, payload, documentHash } = input.action;
  return {
    action: { type, recipient, purpose, payload, documentHash },
    sources: input.sources.map(({ kind, id, quote }) => (quote === undefined ? { kind, id } : { kind, id, quote })),
    consents: input.consents.map(({ recipient, purpose }) => ({ recipient, purpose })),
    origin: input.origin,
  };
}

// The renewal form's personal fields (PORTAL_HOUSEHOLD in Engine's
// executors). None of them ever holds an email address or a link, so one
// that does is held with a plain reason before Guardian is asked. Guardian
// reads every field anyway; this only makes the plainest case certain.
const PERSONAL_FIELDS: Record<string, string> = {
  fullName: "full name",
  dateOfBirth: "date of birth",
  address: "mailing address",
  phone: "phone number",
};
const EMAIL_OR_LINK = /@|:\/\//;

function formProblems(input: CheckInput): string[] {
  const form = input.action.payload;
  if (input.action.type !== "submit" || typeof form !== "object" || form === null || Array.isArray(form)) return [];
  const fields = form as Record<string, unknown>;
  return Object.entries(PERSONAL_FIELDS).flatMap(([name, what]) => {
    const value = fields[name];
    return typeof value === "string" && EMAIL_OR_LINK.test(value)
      ? [`The ${what} on the form holds an email address or a link, so this action is on hold.`]
      : [];
  });
}

// The guardian model alone, with no local rules in front. The request
// carries the action to the check endpoint. Any failure
// (network, timeout, error status, unparsable or invalid answer,
// contradictory verdict) is a block with a message a person can read.
// Engine runs its own rules first and then this.
export class GlimmerModelChecker implements Checker {
  private readonly url: string;
  private readonly token: string;
  private readonly proxyAuth: ProxyAuth | null;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastServer: ServerInfo | null = null;

  constructor(options: GlimmerCheckerOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.proxyAuth = options.proxyAuth ?? null;
    this.model = options.model ?? DEFAULT_GUARDIAN_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
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
  // since a cold check still blocks. With no container up, Modal's proxy
  // answers 503 and starts one.
  async warm(): Promise<WarmState> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ warm: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === STARTING) return "starting";
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
    this.lastServer = null;
    const malformed = formProblems(input);
    if (malformed.length > 0) return { verdict: "block", problems: malformed };

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(modelRequest(input)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") return blocked(COLD);
      return blocked(
        "The safety check could not be reached, so this action is on hold. Please try again.",
      );
    }

    if (response.status === STARTING) return blocked(COLD);
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

// Model-backed checker. Runs Guardian's local rules first and only asks
// the model when the rules pass.
export class GlimmerChecker extends GlimmerModelChecker {
  private readonly rules = new RulesChecker();

  override async check(input: CheckInput): Promise<CheckResult> {
    const rules = await this.rules.check(input);
    if (rules.verdict === "block") return rules;
    return super.check(input);
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
