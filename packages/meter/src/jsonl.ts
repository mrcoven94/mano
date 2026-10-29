// CI and local writer: JSON lines on disk plus a daily summary
// uploaded to R2. One line per record, one file per UTC day:
//
//   usage-2026-10-29.jsonl
//
// A scheduled run (or the end of a CI job) rolls the day file up with
// summarizeDay and uploads the summary to the meter bucket with
// uploadDailySummary. This module touches no filesystem itself: the
// caller injects appendLine (nodeAppendLine in ./nodefs.js), so Workers
// can import the pure parts without node:fs.
import { RECORD_KEYS, type UsageRecord } from "./record.js";
import type { UsageSink } from "./recorder.js";

export const DEFAULT_R2_BUCKET = "mano-meter";
export const DEFAULT_R2_PREFIX = "meter/";

export function dayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function dayFileName(day: string): string {
  return `usage-${day}.jsonl`;
}

// Serializes exactly the record keys, in order. Anything else on the
// object is dropped, so content can never leak into a line.
export function formatLine(record: UsageRecord): string {
  const picked: Record<string, unknown> = {};
  for (const key of RECORD_KEYS) picked[key] = record[key];
  return JSON.stringify(picked);
}

export function parseLine(line: string): UsageRecord {
  return JSON.parse(line) as UsageRecord;
}

export type AppendLine = (path: string, line: string) => void | Promise<void>;

export interface JsonLinesSinkOptions {
  dir: string;
  day?: string;
  appendLine: AppendLine;
}

export class JsonLinesSink implements UsageSink {
  private dir: string;
  private day: string;
  private appendLine: AppendLine;

  constructor(opts: JsonLinesSinkOptions) {
    this.dir = opts.dir.replace(/\/$/, "");
    this.day = opts.day ?? dayKey();
    this.appendLine = opts.appendLine;
  }

  path(): string {
    return `${this.dir}/${dayFileName(this.day)}`;
  }

  async write(record: UsageRecord): Promise<void> {
    await this.appendLine(this.path(), `${formatLine(record)}\n`);
  }
}

export interface DayBucket {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
}

export interface DailySummary {
  day: string;
  totals: DayBucket;
  byPackage: Record<string, DayBucket>;
  byModel: Record<string, DayBucket>;
  byEnvironment: Record<string, DayBucket>;
}

function emptyBucket(): DayBucket {
  return { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0 };
}

function add(bucket: DayBucket, record: UsageRecord): void {
  bucket.calls += 1;
  if (record.status === "error") bucket.errors += 1;
  bucket.inputTokens += record.inputTokens;
  bucket.outputTokens += record.outputTokens;
  bucket.reasoningTokens += record.reasoningTokens;
  bucket.estimatedCostUsd = Math.round((bucket.estimatedCostUsd + record.estimatedCostUsd) * 1e8) / 1e8;
}

export function summarizeDay(records: UsageRecord[], day: string): DailySummary {
  const summary: DailySummary = { day, totals: emptyBucket(), byPackage: {}, byModel: {}, byEnvironment: {} };
  for (const record of records) {
    add(summary.totals, record);
    summary.byPackage[record.package] ??= emptyBucket();
    add(summary.byPackage[record.package], record);
    summary.byModel[record.model] ??= emptyBucket();
    add(summary.byModel[record.model], record);
    summary.byEnvironment[record.environment] ??= emptyBucket();
    add(summary.byEnvironment[record.environment], record);
  }
  return summary;
}

export function summaryKey(prefix: string, day: string): string {
  const clean = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${clean}daily/${day}.json`;
}

// Structural R2 binding: works with the Workers R2Bucket and with any
// test double. The bucket name lives in wrangler.toml / env, never here.
export interface R2BucketLike {
  put(key: string, body: string | Uint8Array): Promise<unknown>;
}

export async function uploadDailySummary(
  bucket: R2BucketLike,
  summary: DailySummary,
  opts: { prefix?: string } = {},
): Promise<string> {
  const key = summaryKey(opts.prefix ?? DEFAULT_R2_PREFIX, summary.day);
  await bucket.put(key, JSON.stringify(summary, null, 2));
  return key;
}
