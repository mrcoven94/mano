// Usage record shape. A record holds counts and labels only: which
// package called, for what purpose, which provider and exact model ID,
// whether the data was synthetic or real, token counts, latency, status
// and estimated cost. It never holds prompts, answers, person IDs,
// phone numbers or any other content. buildRecord enforces this by
// picking the allowed fields one by one, never spreading its input.
import { estimateCostUsd, type RateOverrides } from "./rates.js";

export const METER_PACKAGES = ["engine", "channels", "mail", "proof", "guardian", "quality", "eval"] as const;
export type MeterPackage = (typeof METER_PACKAGES)[number];

export type DataClass = "synthetic" | "real";
export type CallStatus = "ok" | "error";

// Short labels only, never content. Capped so a caller cannot smuggle
// content into a record through an overlong label.
export const MAX_LABEL_LENGTH = 200;

export interface UsageInput {
  package: MeterPackage;
  purpose: string;
  provider: string;
  model: string;
  dataClass: DataClass;
  inputTokens: number;
  outputTokens: number;
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
}

function isMeterPackage(value: unknown): value is MeterPackage {
  return typeof value === "string" && (METER_PACKAGES as readonly string[]).includes(value);
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Meter record needs a non-empty ${field}.`);
  if (value.length > MAX_LABEL_LENGTH) throw new Error(`Meter ${field} is over ${MAX_LABEL_LENGTH} chars; pass a short label, never content.`);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Meter record needs a finite ${field}.`);
  return Math.max(0, Math.floor(value));
}

export function buildRecord(input: UsageInput, opts: BuildOptions = {}): UsageRecord {
  // Every field below is picked by name. Extra keys on the input object
  // (prompt, answer, person ID, phone, content) are dropped. The sentinel
  // test in test/meter.test.ts proves they never reach a record.
  if (!isMeterPackage(input.package)) throw new Error(`Unknown meter package: ${String(input.package)}.`);
  if (input.dataClass !== "synthetic" && input.dataClass !== "real") {
    throw new Error(`Meter dataClass must be synthetic or real, got ${String(input.dataClass)}.`);
  }
  if (input.status !== "ok" && input.status !== "error") {
    throw new Error(`Meter status must be ok or error, got ${String(input.status)}.`);
  }
  const purpose = label(input.purpose, "purpose");
  const provider = label(input.provider, "provider");
  const model = label(input.model, "model");
  const inputTokens = count(input.inputTokens, "inputTokens");
  const outputTokens = count(input.outputTokens, "outputTokens");
  const latencyMs = count(input.latencyMs, "latencyMs");
  return {
    package: input.package,
    purpose,
    provider,
    model,
    dataClass: input.dataClass,
    inputTokens,
    outputTokens,
    latencyMs,
    status: input.status,
    estimatedCostUsd: estimateCostUsd(model, inputTokens, outputTokens, opts.rates),
    at: opts.at ?? new Date().toISOString(),
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
  "inputTokens",
  "outputTokens",
  "latencyMs",
  "status",
  "estimatedCostUsd",
  "at",
];
