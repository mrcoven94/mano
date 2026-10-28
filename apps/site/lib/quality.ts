/* Staff quality page data. Reads nightly run aggregates from the public runs URL
   and per-case detail from the private runs URL, server-side only. The holdout
   never appears per-case. Anything that names a model or provider is stripped
   before render; staff never see those names. */

import { displayTotal, stripModelNames } from "@mano/quality";

export interface SuiteRow {
  version: number;
  cases: number;
  hardCheckPassRate: number;
  judgeMean: number;
  gateFailed: boolean;
  p50Ms: number;
  p95Ms: number;
  usdPer1kAnswers: number;
}

export interface LatestRun {
  runId: string;
  startedAt: string;
  caseCount: number;
  gateFailed: boolean;
  suites: Record<string, SuiteRow>;
  paths: Record<string, { live: boolean; name: string; detail: string }>;
  judge: { live: boolean };
  dns: string;
  calibration: { agreement: number; kept: boolean; provisional: boolean };
  holdout: { configured: boolean; reason?: string };
  prices: { configured: boolean };
}

export interface CaseRow {
  caseId: string;
  suite: string;
  answer: { text: string };
  checks: { id: string; pass: boolean; detail?: string }[];
  judge: { helpful: number; accurate: number; plain: number; warm: number; pass: boolean; reason: string } | null;
}

export interface HistoryRow {
  runId: string;
  startedAt: string;
  caseCount: number;
  gateFailed: boolean;
  suites: Record<string, SuiteRow>;
}

export interface CountersDoc {
  week: string;
  counters: { label: string; n: number }[];
  total: number | null;
  hiddenCells: number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function stripRun(raw: Record<string, unknown>): LatestRun {
  const suites: Record<string, SuiteRow> = {};
  for (const [name, s] of Object.entries((raw.suites ?? {}) as Record<string, SuiteRow>)) {
    suites[name] = {
      version: s.version, cases: s.cases, hardCheckPassRate: s.hardCheckPassRate,
      judgeMean: s.judgeMean, gateFailed: s.gateFailed, p50Ms: s.p50Ms, p95Ms: s.p95Ms,
      usdPer1kAnswers: s.usdPer1kAnswers,
    };
  }
  return {
    runId: String(raw.runId ?? ""),
    startedAt: String(raw.startedAt ?? ""),
    caseCount: Number(raw.caseCount ?? 0),
    gateFailed: raw.gateFailed === true,
    suites,
    paths: (raw.paths ?? {}) as LatestRun["paths"],
    judge: { live: (raw.judge as { live?: unknown } | undefined)?.live === true },
    dns: String(raw.dns ?? ""),
    calibration: {
      agreement: Number((raw.calibration as { agreement?: unknown } | undefined)?.agreement ?? 0),
      kept: (raw.calibration as { kept?: unknown } | undefined)?.kept === true,
      provisional: (raw.calibration as { provisional?: unknown } | undefined)?.provisional !== false,
    },
    holdout: {
      configured: (raw.holdout as { configured?: unknown } | undefined)?.configured === true,
      reason: (raw.holdout as { reason?: string } | undefined)?.reason,
    },
    prices: { configured: (raw.prices as { configured?: unknown } | undefined)?.configured === true },
  };
}

function cleanCase(c: CaseRow): CaseRow {
  return {
    ...c,
    answer: { text: stripModelNames(c.answer.text) },
    checks: c.checks.map((r) => ({ ...r, detail: r.detail === undefined ? undefined : stripModelNames(r.detail) })),
    judge: c.judge ? { ...c.judge, reason: stripModelNames(c.judge.reason) } : null,
  };
}

export async function loadQuality(base: string, privateBase: string): Promise<{
  latest: LatestRun | null;
  history: HistoryRow[];
  lowest: CaseRow[];
  failed: CaseRow[];
  casesConnected: boolean;
  counters: CountersDoc | null;
}> {
  const raw = await fetchJson<Record<string, unknown>>(`${base}/latest.json`);
  const latest = raw ? stripRun(raw) : null;
  const history = (await fetchJson<HistoryRow[]>(`${base}/history.json`)) ?? [];
  let lowest: CaseRow[] = [];
  let failed: CaseRow[] = [];
  let casesConnected = false;
  if (latest && privateBase) {
    const cases = (await fetchJson<CaseRow[]>(`${privateBase}/runs/${latest.runId}/cases.json`)) ?? [];
    casesConnected = cases.length > 0;
    const visible = cases.filter((c) => c.suite !== "safety-holdout").map(cleanCase);
    const judged = visible.filter((c) => c.judge !== null);
    judged.sort((a, b) => mean(b.judge!) - mean(a.judge!));
    lowest = judged.slice(-5).reverse();
    failed = visible.filter((c) => c.checks.some((r) => !r.pass)).slice(0, 10);
  }
  const countersUrl = process.env.QUALITY_COUNTERS_URL ?? "";
  const counters = countersUrl ? await fetchJson<CountersDoc>(countersUrl) : null;
  return { latest, history: history.slice(-14), lowest, failed, casesConnected, counters };
}

function mean(j: NonNullable<CaseRow["judge"]>): number {
  return (j.helpful + j.accurate + j.plain + j.warm) / 4;
}

export function judgeMeanOf(j: CaseRow["judge"]): number | null {
  return j ? mean(j) : null;
}

// Totals are withheld whenever any cell is suppressed, so hidden counts
// cannot be recovered by subtraction. Enforced here as well as at the source.
export function countersTotal(doc: CountersDoc): number | null {
  return displayTotal(doc.hiddenCells, doc.total);
}
