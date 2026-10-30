/* Staff quality page data, server-side only. The latest run and its history
   come from the mano-quality bucket (aggregates only); per-case results come
   from mano-quality-private. Both are read with signed requests, so neither
   bucket needs a public URL. The holdout never appears per case. Every string
   that reaches the page passes the model-name filter; the page never renders
   model IDs at all. */

import {
  PRIVATE_BUCKET,
  PUBLIC_BUCKET,
  r2CredsFromEnv,
  r2GetJson,
  scrubStaffCase,
  stripModelNames,
  type CaseResult,
  type HistoryRow,
  type RunReport,
} from "@mano/quality/site";

export type { HistoryRow, RunReport };

export interface StaffCaseRow {
  caseId: string;
  suite: string;
  live: boolean;
  bubbles: string[];
  failed: { id: string; detail: string }[];
  judge: { mean: number; helpful: number; accurate: number; plain: number; warm: number; reason: string } | null;
}

export interface QualityData {
  latest: RunReport;
  // "<case id> <check>" to the check's detail, from the private results.
  // The public report carries identifiers only.
  failureDetails: Record<string, string>;
  history: HistoryRow[];
  lowest: StaffCaseRow[];
  failed: StaffCaseRow[];
  casesConnected: boolean;
  standins: string[];
}

export type LoadResult = { state: "unconfigured" } | { state: "empty" } | { state: "error" } | { state: "ok"; data: QualityData };

function toRow(c: CaseResult): StaffCaseRow {
  const clean = scrubStaffCase({ caseId: c.caseId, suite: c.suite, answer: { text: c.answer.text }, checks: c.checks, judge: c.judge });
  const j = clean.judge;
  return {
    caseId: clean.caseId,
    suite: clean.suite,
    live: c.path?.live === true,
    bubbles: clean.answer.text.split("\n").filter((b) => b.trim().length > 0),
    failed: clean.checks.filter((r) => !r.pass).map((r) => ({ id: r.id, detail: r.detail ?? "" })),
    judge: j ? { mean: (j.helpful + j.accurate + j.plain + j.warm) / 4, helpful: j.helpful, accurate: j.accurate, plain: j.plain, warm: j.warm, reason: j.reason } : null,
  };
}

export async function loadQuality(): Promise<LoadResult> {
  const creds = r2CredsFromEnv(process.env);
  if (!creds) return { state: "unconfigured" };
  let latest: RunReport | null;
  let history: HistoryRow[];
  try {
    [latest, history] = await Promise.all([
      r2GetJson<RunReport>(creds, PUBLIC_BUCKET, "latest.json"),
      r2GetJson<HistoryRow[]>(creds, PUBLIC_BUCKET, "history.json").then((h) => h ?? []),
    ]);
  } catch {
    return { state: "error" };
  }
  if (!latest) return { state: "empty" };
  let cases: CaseResult[] = [];
  let casesConnected = false;
  try {
    cases = (await r2GetJson<CaseResult[]>(creds, PRIVATE_BUCKET, `runs/${latest.runId}/cases.json`)) ?? [];
    casesConnected = cases.length > 0;
  } catch {
    casesConnected = false;
  }
  // Only live answers are worth reading here; a stand-in prints the
  // reference answer, which says nothing about Mano.
  const rows = cases.filter((c) => c.suite !== "safety-holdout" && c.path?.live === true).map(toRow);
  const lowest = rows.filter((r) => r.judge !== null).sort((a, b) => a.judge!.mean - b.judge!.mean).slice(0, 6);
  const failed = rows.filter((r) => r.failed.length > 0).sort((a, b) => b.failed.length - a.failed.length);
  // Free-text fields the page shows, cleaned like everything else.
  latest.eligibility = { ...latest.eligibility, reasons: latest.eligibility.reasons.map(stripModelNames) };
  if (latest.probes) latest.probes = { ...latest.probes, detail: stripModelNames(latest.probes.detail) };
  if (latest.guardian) latest.guardian = { ...latest.guardian, detail: stripModelNames(latest.guardian.detail) };
  if (latest.mail) latest.mail = { ...latest.mail, detail: stripModelNames(latest.mail.detail) };
  const failureDetails: Record<string, string> = {};
  for (const c of cases) {
    if (c.suite === "safety-holdout") continue;
    for (const r of c.checks) if (!r.pass && r.detail) failureDetails[`${c.caseId} ${r.id}`] = stripModelNames(r.detail);
  }
  return {
    state: "ok",
    data: {
      latest,
      failureDetails,
      history: history.slice(-60),
      lowest,
      failed,
      casesConnected,
      standins: (latest.standins ?? []).map(stripModelNames),
    },
  };
}
