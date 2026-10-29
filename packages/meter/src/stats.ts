// Stats for the public usage page (/stats on withmano.com). Pure
// functions over meter records and history reports: no I/O, no fetch,
// no secrets. The site loads records and history from R2 (see ./r2.js)
// and folds them through these functions.
import type { UsageRecord } from "./record.js";

export type { UsageRecord } from "./record.js";

// Nearest-rank percentile over a copy of the values. Returns null for
// an empty list so callers say "none recorded" instead of showing 0.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const rank = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return [...values].sort((a, b) => a - b)[rank]!;
}

export interface ModelRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  estimatedCostUsd: number;
}

// Providers that answer without calling a model. Their records stay in
// the totals and model rows, but Meta shares are shares of model
// calls, so test doubles are out of the denominator. A package adds
// its double here in the PR that wires it. The page shows the excluded
// count, so the denominator is inspectable.
export const TEST_DOUBLE_PROVIDERS: readonly string[] = ["stand-in"];

export interface UsageSummary {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  estimatedCostUsd: number;
  metaCalls: number;
  metaTokens: number;
  testDoubleCalls: number;
  // Share of model calls and model tokens served by Meta models.
  // Null when the denominator is zero so the page can say none were
  // recorded.
  metaCallShare: number | null;
  metaTokenShare: number | null;
  byModel: ModelRow[];
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  // Production means environment "production". A stand-in can serve
  // real traffic and CI can replay real prompts, so data class never
  // decides this. Everything else is reported separately, never as
  // production.
  productionCalls: number;
  productionTokens: number;
  productionMetaCallShare: number | null;
  productionMetaTokenShare: number | null;
  range: { from: string; to: string } | null;
}

function share(part: number, total: number): number | null {
  if (total === 0) return null;
  return part / total;
}

function roundCost(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let estimatedCostUsd = 0;
  let metaCalls = 0;
  let metaTokens = 0;
  let testDoubleCalls = 0;
  let testDoubleTokens = 0;
  let productionCalls = 0;
  let productionTokens = 0;
  let productionMetaCalls = 0;
  let productionMetaTokens = 0;
  let productionTestDoubleCalls = 0;
  let productionTestDoubleTokens = 0;
  const latencies: number[] = [];
  const days: string[] = [];
  const models = new Map<string, ModelRow>();
  for (const record of records) {
    if (record.status === "error") errors += 1;
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    reasoningTokens += record.reasoningTokens;
    estimatedCostUsd = roundCost(estimatedCostUsd + record.estimatedCostUsd);
    const tokens = record.inputTokens + record.outputTokens;
    const isTestDouble = TEST_DOUBLE_PROVIDERS.includes(record.provider);
    if (isTestDouble) {
      testDoubleCalls += 1;
      testDoubleTokens += tokens;
    }
    if (record.provider === "meta") {
      metaCalls += 1;
      metaTokens += tokens;
    }
    if (record.environment === "production") {
      productionCalls += 1;
      productionTokens += tokens;
      if (isTestDouble) {
        productionTestDoubleCalls += 1;
        productionTestDoubleTokens += tokens;
      }
      if (record.provider === "meta") {
        productionMetaCalls += 1;
        productionMetaTokens += tokens;
      }
    }
    // Latency is the latency of answers. Failed attempts carry no
    // per-attempt timing, so only ok records feed the percentiles.
    if (record.status === "ok") latencies.push(record.latencyMs);
    days.push(record.at.slice(0, 10));
    const row = models.get(record.model) ?? {
      model: record.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      tokens: 0,
      estimatedCostUsd: 0,
    };
    row.calls += 1;
    row.inputTokens += record.inputTokens;
    row.outputTokens += record.outputTokens;
    row.reasoningTokens += record.reasoningTokens;
    row.tokens += tokens;
    row.estimatedCostUsd = roundCost(row.estimatedCostUsd + record.estimatedCostUsd);
    models.set(record.model, row);
  }
  days.sort();
  return {
    calls: records.length,
    errors,
    inputTokens,
    outputTokens,
    reasoningTokens,
    tokens: inputTokens + outputTokens,
    estimatedCostUsd,
    metaCalls,
    metaTokens,
    testDoubleCalls,
    metaCallShare: share(metaCalls, records.length - testDoubleCalls),
    metaTokenShare: share(metaTokens, inputTokens + outputTokens - testDoubleTokens),
    byModel: [...models.values()].sort((a, b) => b.calls - a.calls || (a.model < b.model ? -1 : 1)),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    productionCalls,
    productionTokens,
    productionMetaCallShare: share(productionMetaCalls, productionCalls - productionTestDoubleCalls),
    productionMetaTokenShare: share(productionMetaTokens, productionTokens - productionTestDoubleTokens),
    range: days.length > 0 ? { from: days[0]!, to: days[days.length - 1]! } : null,
  };
}

// Keep records on or after a UTC day (YYYY-MM-DD). Null keeps all.
export function filterRecordsSince(records: UsageRecord[], sinceDay: string | null): UsageRecord[] {
  if (sinceDay === null) return records;
  return records.filter((record) => record.at.slice(0, 10) >= sinceDay);
}

// The UTC day cutoff for a "last N days" window ending today. Exported
// so the site and the tests share the same math.
export function sinceDayForWindow(days: number, today: Date = new Date()): string {
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  return cutoff.toISOString().slice(0, 10);
}

// The explicit UTC day list for a "last N days" window ending today.
// The site fetches exactly these day files from R2.
export function daysForWindow(days: number, today: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - i);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

// Build history file shape, matching history/collect.mjs output.
export interface ClassCounts {
  "muse-code": number;
  architect: number;
  person: number;
}

export interface HistoryDay {
  commits: ClassCounts;
  lines: ClassCounts;
  prsOpened: number;
  prsMerged: number;
}

export interface HistorySession {
  commits: ClassCounts;
  lines: ClassCounts;
  prsOpened: number;
  prsMerged: number;
  reviewRounds: number;
  multiModelReviews: number;
  openToMergeSeconds: { count: number; total: number; avg: number | null };
}

export interface HistoryPr {
  number: number;
  session: string;
  state: string;
  openedDay: string;
  mergedDay: string | null;
  openToMergeSeconds: number | null;
  comments: number;
  ownerComments: number;
  reviewRounds: number;
  multiModelReviews: number;
  formalReviews: { approved: number; changesRequested: number; commented: number; dismissed: number };
}

export interface HistoryFile {
  generatedAt: string | null;
  repo: string;
  days: Record<string, HistoryDay>;
  sessions: Record<string, HistorySession>;
  prs: HistoryPr[];
}

// Shape guard for the history file the loader reads from R2. A file
// that fails this is treated as absent, never rendered halfway.
export function isHistoryFile(value: unknown): value is HistoryFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  if (typeof file.repo !== "string") return false;
  if (file.generatedAt !== null && typeof file.generatedAt !== "string") return false;
  if (typeof file.days !== "object" || file.days === null) return false;
  if (typeof file.sessions !== "object" || file.sessions === null) return false;
  if (!Array.isArray(file.prs)) return false;
  return true;
}

export interface HistorySummary {
  generatedAt: string | null;
  repo: string;
  prsOpened: number;
  prsMerged: number;
  reviewRounds: number;
  multiModelReviews: number;
  commitsByClass: ClassCounts;
  linesByClass: ClassCounts;
  commits: number;
  lines: number;
  museCommitShare: number | null;
  museLineShare: number | null;
  avgOpenToMergeSeconds: number | null;
  mergedWithTiming: number;
  range: { from: string; to: string } | null;
}

export interface SessionRow {
  session: string;
  commits: number;
  lines: number;
  prsMerged: number;
  reviewRounds: number;
  multiModelReviews: number;
}

function emptyClassCounts(): ClassCounts {
  return { "muse-code": 0, architect: 0, person: 0 };
}

// Day buckets and PR rows are filtered by the same cutoff; session
// aggregates in the file are whole-project and stay out of this.
export function summarizeHistory(history: HistoryFile, sinceDay: string | null = null): HistorySummary {
  const commitsByClass = emptyClassCounts();
  const linesByClass = emptyClassCounts();
  let prsOpened = 0;
  let prsMerged = 0;
  const dayKeys: string[] = [];
  for (const [day, bucket] of Object.entries(history.days)) {
    if (sinceDay !== null && day < sinceDay) continue;
    dayKeys.push(day);
    prsOpened += bucket.prsOpened;
    prsMerged += bucket.prsMerged;
    for (const cls of ["muse-code", "architect", "person"] as const) {
      commitsByClass[cls] += bucket.commits[cls];
      linesByClass[cls] += bucket.lines[cls];
    }
  }
  let reviewRounds = 0;
  let multiModelReviews = 0;
  let timingTotal = 0;
  let timingCount = 0;
  for (const pr of history.prs) {
    if (sinceDay !== null && pr.openedDay < sinceDay) continue;
    reviewRounds += pr.reviewRounds;
    multiModelReviews += pr.multiModelReviews;
    if (pr.openToMergeSeconds !== null) {
      timingTotal += pr.openToMergeSeconds;
      timingCount += 1;
    }
  }
  dayKeys.sort();
  const commits = commitsByClass["muse-code"] + commitsByClass.architect + commitsByClass.person;
  const lines = linesByClass["muse-code"] + linesByClass.architect + linesByClass.person;
  return {
    generatedAt: history.generatedAt,
    repo: history.repo,
    prsOpened,
    prsMerged,
    reviewRounds,
    multiModelReviews,
    commitsByClass,
    linesByClass,
    commits,
    lines,
    museCommitShare: share(commitsByClass["muse-code"], commits),
    museLineShare: share(linesByClass["muse-code"], lines),
    avgOpenToMergeSeconds: timingCount === 0 ? null : Math.round(timingTotal / timingCount),
    mergedWithTiming: timingCount,
    range: dayKeys.length > 0 ? { from: dayKeys[0]!, to: dayKeys[dayKeys.length - 1]! } : null,
  };
}

// Whole-project session table, sorted by lines changed. Session
// aggregates are only stored whole-project, so this never filters.
export function summarizeSessions(history: HistoryFile): SessionRow[] {
  const rows: SessionRow[] = Object.entries(history.sessions).map(([session, s]) => ({
    session,
    commits: s.commits["muse-code"] + s.commits.architect + s.commits.person,
    lines: s.lines["muse-code"] + s.lines.architect + s.lines.person,
    prsMerged: s.prsMerged,
    reviewRounds: s.reviewRounds,
    multiModelReviews: s.multiModelReviews,
  }));
  rows.sort((a, b) => b.lines - a.lines || (a.session < b.session ? -1 : 1));
  return rows;
}
