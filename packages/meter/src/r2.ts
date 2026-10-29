// Live stats source: reads usage records and the history report from
// the public R2 bucket the nightly workflow writes. No secrets: the
// base URL is public (a custom domain or the bucket's public URL) and
// every payload holds counts only. Records are re-validated through
// buildRecord on the way in, so the page can only render records the
// recorder itself would have written; malformed lines are skipped and
// counted, never rendered.
import { buildRecord, type UsageRecord } from "./record.js";
import { isHistoryFile, type HistoryFile } from "./stats.js";

export const USAGE_RECORDS_PREFIX = "meter/usage/records/";
export const USAGE_INDEX_KEY = "meter/usage/index.json";
export const HISTORY_LATEST_KEY = "meter/history/latest.json";

export interface UsageIndex {
  generatedAt: string;
  dataset: string;
  days: string[];
  truncated: boolean;
}

export interface StatsLoad {
  records: UsageRecord[];
  skippedLines: number;
  history: HistoryFile | null;
  // Days the index advertised. Null when the index itself is absent.
  indexedDays: string[] | null;
  usageTruncated: boolean;
}

export interface LoadStatsOptions {
  baseUrl: string;
  // Null reads the index and loads every indexed day. Otherwise only
  // these UTC days (YYYY-MM-DD) are fetched; missing days are skipped.
  days: string[] | null;
  fetchImpl?: typeof fetch;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function joinUrl(baseUrl: string, key: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error(`Meter R2 base URL must be http(s), got ${base.protocol}.`);
  }
  return new URL(key, base.href.endsWith("/") ? base.href : `${base.href}/`).href;
}

function isUsageIndex(value: unknown): value is UsageIndex {
  if (typeof value !== "object" || value === null) return false;
  const index = value as Record<string, unknown>;
  return (
    typeof index.generatedAt === "string" &&
    typeof index.dataset === "string" &&
    Array.isArray(index.days) &&
    index.days.every((day) => typeof day === "string" && DAY_PATTERN.test(day)) &&
    typeof index.truncated === "boolean"
  );
}

function recordsFromJsonl(text: string): { records: UsageRecord[]; skipped: number } {
  const records: UsageRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      records.push(
        buildRecord(parsed as unknown as Parameters<typeof buildRecord>[0], {
          at: typeof parsed.at === "string" ? parsed.at : undefined,
        }),
      );
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Meter R2 read failed: ${res.status} for ${url}.`);
  return res.text();
}

export async function loadStatsFromR2(opts: LoadStatsOptions): Promise<StatsLoad> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const empty: StatsLoad = { records: [], skippedLines: 0, history: null, indexedDays: null, usageTruncated: false };
  let days = opts.days;
  let truncated = false;
  if (days === null) {
    const raw = await fetchText(joinUrl(opts.baseUrl, USAGE_INDEX_KEY), fetchImpl);
    if (raw === null) return empty;
    let index: unknown;
    try {
      index = JSON.parse(raw);
    } catch {
      return empty;
    }
    if (!isUsageIndex(index)) return empty;
    empty.indexedDays = index.days;
    truncated = index.truncated;
    days = index.days;
  }
  for (const day of days) {
    if (!DAY_PATTERN.test(day)) continue;
    const raw = await fetchText(joinUrl(opts.baseUrl, `${USAGE_RECORDS_PREFIX}${day}.jsonl`), fetchImpl);
    if (raw === null) continue;
    const parsed = recordsFromJsonl(raw);
    empty.records.push(...parsed.records);
    empty.skippedLines += parsed.skipped;
  }
  empty.usageTruncated = truncated;
  const historyRaw = await fetchText(joinUrl(opts.baseUrl, HISTORY_LATEST_KEY), fetchImpl);
  if (historyRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(historyRaw);
      if (isHistoryFile(parsed)) empty.history = parsed;
    } catch {
      // Treated as absent below; a corrupt history file must never
      // break the page.
    }
  }
  return empty;
}
