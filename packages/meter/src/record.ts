// Usage record shape. A record holds counts and labels only: which
// package called, for what purpose, which provider and exact model ID,
// which environment the call ran in, whether the data was synthetic or
// real, token counts (with reasoning split out), latency, status and
// estimated cost. It never holds prompts, answers, person IDs, phone
// numbers or any other content. buildRecord enforces this by picking
// the allowed fields one by one (never spreading its input) and by
// allowlisting every label: purpose, provider, package, environment,
// data class and status must each be a known value, and the model ID
// must match a tight pattern. Anything else throws.
import { estimateCostUsd, type RateOverrides } from "./rates.js";

export const METER_PACKAGES = ["engine", "channels", "mail", "proof", "guardian", "quality", "eval"] as const;
export type MeterPackage = (typeof METER_PACKAGES)[number];

// Every purpose a wired package records under. A package adds its
// purpose here in the PR that wires it in. Unknown purposes throw
// rather than letting free text (and so content) into a record.
export const METER_PURPOSES = ["answer-texts"] as const;
export type MeterPurpose = (typeof METER_PURPOSES)[number];

// Providers with a wired client. Non-Meta providers get their own
// value here when they are wired, so they are counted honestly and
// never smuggled through as free text.
export const METER_PROVIDERS = ["meta", "stand-in"] as const;
export type MeterProvider = (typeof METER_PROVIDERS)[number];

export type DataClass = "synthetic" | "real";
export type CallStatus = "ok" | "error";

// Where the call ran. Separate from synthetic or real: a stand-in can
// serve real traffic, and production numbers come only from
// environment "production", never from data class.
export const METER_ENVIRONMENTS = ["production", "preview", "ci", "local"] as const;
export type MeterEnvironment = (typeof METER_ENVIRONMENTS)[number];

// Exact model IDs only: letters, digits, dots and dashes. No spaces,
// no slashes, no room for a sentence.
export const MODEL_ID_PATTERN = /^[A-Za-z0-9.-]{1,100}$/;

export interface UsageInput {
  package: MeterPackage;
  purpose: MeterPurpose;
  provider: MeterProvider;
  model: string;
  dataClass: DataClass;
  environment: MeterEnvironment;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  status: CallStatus;
}

export interface UsageRecord extends UsageInput {
  estimatedCostUsd: number;
  at: string;
}

export interface BuildOptions {
  at?: string;
  rates?: RateOverrides;
  now?: () => number;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

// Records started when the meter shipped; anything earlier is a bug,
// and anything more than a day in the future is clock skew or garbage.
const MIN_AT_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MAX_FUTURE_SKEW_MS = 86_400_000;

function timestamp(at: string | undefined, nowMs: number): string {
  if (at === undefined) return new Date(nowMs).toISOString();
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`Meter timestamp is not a date: ${at}.`);
  if (ms < MIN_AT_MS || ms > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new Error(`Meter timestamp ${at} is outside the plausible range.`);
  }
  return new Date(ms).toISOString();
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Meter record needs a finite ${field}.`);
  return Math.max(0, Math.floor(value));
}

export function buildRecord(input: UsageInput, opts: BuildOptions = {}): UsageRecord {
  // Every field below is picked by name. Extra keys on the input object
  // (prompt, answer, person ID, phone, content) are dropped. The sentinel
  // test in test/meter.test.ts proves they never reach a record.
  if (!isOneOf(input.package, METER_PACKAGES)) throw new Error(`Unknown meter package: ${String(input.package)}.`);
  if (!isOneOf(input.purpose, METER_PURPOSES)) {
    throw new Error(`Unknown meter purpose: ${String(input.purpose)}. Add it to METER_PURPOSES when a package wires in.`);
  }
  if (!isOneOf(input.provider, METER_PROVIDERS)) {
    throw new Error(`Unknown meter provider: ${String(input.provider)}. Add it to METER_PROVIDERS when a client wires in.`);
  }
  if (typeof input.model !== "string" || !MODEL_ID_PATTERN.test(input.model)) {
    throw new Error(`Meter model must match ${MODEL_ID_PATTERN}, got ${String(input.model)}.`);
  }
  if (!isOneOf(input.dataClass, ["synthetic", "real"] as const)) {
    throw new Error(`Meter dataClass must be synthetic or real, got ${String(input.dataClass)}.`);
  }
  if (!isOneOf(input.environment, METER_ENVIRONMENTS)) {
    throw new Error(`Meter environment must be one of ${METER_ENVIRONMENTS.join(", ")}, got ${String(input.environment)}.`);
  }
  if (!isOneOf(input.status, ["ok", "error"] as const)) {
    throw new Error(`Meter status must be ok or error, got ${String(input.status)}.`);
  }
  const inputTokens = count(input.inputTokens, "inputTokens");
  const outputTokens = count(input.outputTokens, "outputTokens");
  const reasoningTokens = count(input.reasoningTokens, "reasoningTokens");
  const latencyMs = count(input.latencyMs, "latencyMs");
  // Provider output counts include reasoning tokens, so cost needs no
  // separate reasoning term; the split is for display only.
  const estimatedCostUsd = estimateCostUsd(input.model, inputTokens, outputTokens, opts.rates);
  return {
    package: input.package,
    purpose: input.purpose,
    provider: input.provider,
    model: input.model,
    dataClass: input.dataClass,
    environment: input.environment,
    inputTokens,
    outputTokens,
    reasoningTokens,
    latencyMs,
    status: input.status,
    estimatedCostUsd,
    at: timestamp(opts.at, (opts.now ?? Date.now)()),
  };
}

// The exact keys a record may carry. Sinks and tests use this to prove
// no other field (and so no content) is ever written.
export const RECORD_KEYS: readonly (keyof UsageRecord)[] = [
  "package",
  "purpose",
  "provider",
  "model",
  "dataClass",
  "environment",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "latencyMs",
  "status",
  "estimatedCostUsd",
  "at",
];
