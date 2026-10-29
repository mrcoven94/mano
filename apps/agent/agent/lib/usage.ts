// Local usage records, content-free like Meter's. Temporary: when
// packages/meter (LAP-602) merges, this file goes away and callers use
// MeterRecorder with package "agent" instead. The record shape below
// matches Meter's UsageRecord field for field so the switch is mechanical.
export type DataClass = "synthetic" | "real";
export type CallStatus = "ok" | "error";

export interface UsageInput {
  package: string;
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

export interface ModelRate {
  inputPer1kUsd: number;
  outputPer1kUsd: number;
}

// Mirrors Meter's MODEL_RATES, plus the contributor tier Meter does not
// list yet (Meter estimates unknown models at zero; the contributor rate
// here is the published $0.10/$0.20 per 1M tokens).
export const MODEL_RATES: Record<string, ModelRate> = {
  "muse-spark-1.3": { inputPer1kUsd: 0.0015, outputPer1kUsd: 0.006 },
  "muse-spark-1.3-contributor": { inputPer1kUsd: 0.0001, outputPer1kUsd: 0.0002 },
  "muse-spark": { inputPer1kUsd: 0.0015, outputPer1kUsd: 0.006 },
  "muse-wonder": { inputPer1kUsd: 0.003, outputPer1kUsd: 0.012 },
  "stand-in": { inputPer1kUsd: 0, outputPer1kUsd: 0 },
  fake: { inputPer1kUsd: 0, outputPer1kUsd: 0 },
  recorded: { inputPer1kUsd: 0, outputPer1kUsd: 0 },
};

export const FALLBACK_RATE: ModelRate = { inputPer1kUsd: 0, outputPer1kUsd: 0 };

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_RATES[model] ?? FALLBACK_RATE;
  const cost = (inputTokens / 1000) * rate.inputPer1kUsd + (outputTokens / 1000) * rate.outputPer1kUsd;
  return Math.round(cost * 1e8) / 1e8;
}

const MAX_LABEL_LENGTH = 200;

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Usage record needs a non-empty ${field}.`);
  if (value.length > MAX_LABEL_LENGTH) {
    throw new Error(`Usage ${field} is over ${MAX_LABEL_LENGTH} chars; pass a short label, never content.`);
  }
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Usage record needs a finite ${field}.`);
  return Math.max(0, Math.floor(value));
}

// Every field below is picked by name. Extra keys on the input object
// (prompt, answer, person ID, phone, content) are dropped.
export function buildRecord(input: UsageInput, at: string = new Date().toISOString()): UsageRecord {
  if (input.package !== "agent") throw new Error(`Unknown usage package: ${String(input.package)}.`);
  if (input.dataClass !== "synthetic" && input.dataClass !== "real") {
    throw new Error(`Usage dataClass must be synthetic or real, got ${String(input.dataClass)}.`);
  }
  if (input.status !== "ok" && input.status !== "error") {
    throw new Error(`Usage status must be ok or error, got ${String(input.status)}.`);
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
    estimatedCostUsd: estimateCostUsd(model, inputTokens, outputTokens),
    at,
  };
}

export interface UsageSink {
  write(record: UsageRecord): void | Promise<void>;
}

// Production sink: one JSON line per call on stdout, where Vercel Logs
// keeps it. Content-free by construction of buildRecord.
export class JsonLineSink implements UsageSink {
  write(record: UsageRecord): void {
    console.log(JSON.stringify({ type: "mano_usage", ...record }));
  }
}

export class MemorySink implements UsageSink {
  records: UsageRecord[] = [];
  write(record: UsageRecord): void {
    this.records.push(record);
  }
}

export class UsageRecorder {
  private sinks: UsageSink[];
  constructor(sinks: UsageSink[] = [new JsonLineSink()]) {
    this.sinks = sinks;
  }

  async record(input: UsageInput): Promise<UsageRecord> {
    const record = buildRecord(input);
    for (const sink of this.sinks) await sink.write(record);
    return record;
  }
}

export function startCall(now: () => number = Date.now): () => number {
  const started = now();
  return () => Math.max(0, now() - started);
}
