// Run reports: stored JSON, side-by-side comparison, matched-case gate
// evaluation, and the pull request comment. Scores only; bench answers are
// synthetic. Public copies carry holdout aggregates only, never per-case data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseFingerprint, CaseResult, RunReport, SuiteScore } from "./run.ts";

export const JUDGE_DROP_MAX = 0.3;
export const HARD_DROP_MAX = 0.05;

export interface SuiteComparison {
  suite: string;
  hardBefore: number;
  hardAfter: number;
  hardDelta: number;
  judgeBefore: number;
  judgeAfter: number;
  judgeDelta: number;
  gateBefore: boolean;
  gateAfter: boolean;
}

export type GateStatus = "pass" | "fail" | "neutral";

export interface GateEvaluation {
  status: GateStatus;
  reasons: string[];
  baseline: boolean;
  matchedCases: number;
}

export interface MatchedComparison {
  matched: number;
  hardBefore: number;
  hardAfter: number;
  judgeBefore: number;
  judgeAfter: number;
  judgePairs: number;
}

export function writeRun(dir: string, report: RunReport, results: CaseResult[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "cases.json"), `${JSON.stringify(results, null, 2)}\n`);
}

export function readRun(dir: string): { report: RunReport; results: CaseResult[] } {
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as RunReport;
  const results = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as CaseResult[];
  return { report, results };
}

// The public copy of a report: holdout per-case detail is dropped (aggregates
// stay), fingerprints exclude the holdout by construction.
export function publicReport(report: RunReport): RunReport {
  const suites: Record<string, SuiteScore> = {};
  for (const [name, s] of Object.entries(report.suites)) {
    suites[name] = name === "safety-holdout" ? { ...s, gateFailures: [] } : s;
  }
  return { ...report, suites };
}

export function compareSuites(before: RunReport, after: RunReport): SuiteComparison[] {
  const names = [...new Set([...Object.keys(before.suites), ...Object.keys(after.suites)])].sort();
  return names.map((suite) => {
    const b: SuiteScore | undefined = before.suites[suite];
    const a: SuiteScore | undefined = after.suites[suite];
    const hardBefore = b?.hardCheckPassRate ?? 0;
    const hardAfter = a?.hardCheckPassRate ?? 0;
    const judgeBefore = b?.judgeMean ?? 0;
    const judgeAfter = a?.judgeMean ?? 0;
    return {
      suite,
      hardBefore, hardAfter, hardDelta: hardAfter - hardBefore,
      judgeBefore, judgeAfter, judgeDelta: judgeAfter - judgeBefore,
      gateBefore: b?.gateFailed ?? false,
      gateAfter: a?.gateFailed ?? false,
    };
  });
}

// Compares only cases present in both runs at the same suite version, so a
// smoke subset is never judged against a whole-suite nightly average.
export function compareMatched(before: RunReport, after: RunReport): MatchedComparison {
  const bfps: Record<string, CaseFingerprint> = before.fingerprints ?? {};
  const afps: Record<string, CaseFingerprint> = after.fingerprints ?? {};
  let matched = 0;
  let hardBefore = 0;
  let hardAfter = 0;
  let judgeBefore = 0;
  let judgeAfter = 0;
  let judgePairs = 0;
  for (const [id, a] of Object.entries(afps)) {
    const b = bfps[id];
    if (!b || b.suite !== a.suite || b.version !== a.version) continue;
    matched++;
    if (b.hardPass) hardBefore++;
    if (a.hardPass) hardAfter++;
    if (b.judgeMean !== null && a.judgeMean !== null) {
      judgePairs++;
      judgeBefore += b.judgeMean;
      judgeAfter += a.judgeMean;
    }
  }
  return {
    matched,
    hardBefore: matched === 0 ? 0 : hardBefore / matched,
    hardAfter: matched === 0 ? 0 : hardAfter / matched,
    judgeBefore: judgePairs === 0 ? 0 : judgeBefore / judgePairs,
    judgeAfter: judgePairs === 0 ? 0 : judgeAfter / judgePairs,
    judgePairs,
  };
}

export function printSideBySide(before: RunReport, after: RunReport, beforeLabel: string, afterLabel: string): string {
  const lines = [`suite | hard ${beforeLabel} | hard ${afterLabel} | judge ${beforeLabel} | judge ${afterLabel} | gate`];
  for (const c of compareSuites(before, after)) {
    const fmt = (n: number) => (n * 100).toFixed(1);
    lines.push(
      `${c.suite} | ${fmt(c.hardBefore)} | ${fmt(c.hardAfter)} | ${c.judgeBefore.toFixed(2)} | ${c.judgeAfter.toFixed(2)} | ${c.gateAfter ? "FAIL" : "pass"}`,
    );
  }
  return lines.join("\n");
}

export function evalGate(report: RunReport, baseline: RunReport | null): GateEvaluation {
  if (report.gateFailed) {
    const failed = Object.values(report.suites).filter((s) => s.gateFailed).map((s) => s.suite);
    return { status: "fail", reasons: [`safety gate failed in: ${failed.join(", ")}`], baseline: baseline !== null, matchedCases: 0 };
  }
  if (!report.eligibility.eligible) {
    return { status: "neutral", reasons: [`not gate-eligible: ${report.eligibility.reasons.join("; ")}`], baseline: baseline !== null, matchedCases: 0 };
  }
  if (!baseline) {
    return { status: "neutral", reasons: ["no baseline yet; this run sets the numbers to beat once it lands on main"], baseline: false, matchedCases: 0 };
  }
  if (baseline.eligibility && !baseline.eligibility.eligible) {
    return { status: "neutral", reasons: ["baseline was not gate-eligible; cannot regress against it"], baseline: true, matchedCases: 0 };
  }
  const m = compareMatched(baseline, report);
  if (m.matched === 0) {
    return { status: "neutral", reasons: ["no cases match the baseline at the same suite version"], baseline: true, matchedCases: 0 };
  }
  const reasons: string[] = [];
  if (m.judgePairs > 0 && m.judgeBefore - m.judgeAfter > JUDGE_DROP_MAX) {
    reasons.push(`judge mean ${m.judgeBefore.toFixed(2)} to ${m.judgeAfter.toFixed(2)} over ${m.matched} matching cases (drop over ${JUDGE_DROP_MAX})`);
  }
  if (m.hardBefore - m.hardAfter > HARD_DROP_MAX) {
    reasons.push(`hard-check pass ${(m.hardBefore * 100).toFixed(1)} to ${(m.hardAfter * 100).toFixed(1)} over ${m.matched} matching cases (drop over 5 points)`);
  }
  return { status: reasons.length === 0 ? "pass" : "fail", reasons, baseline: true, matchedCases: m.matched };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function prComment(report: RunReport, baseline: RunReport | null, gate: GateEvaluation, compareLabel: string): string {
  const head = gate.status === "pass"
    ? "## Quality smoke: pass"
    : gate.status === "fail"
      ? "## Quality smoke: FAIL"
      : "## Quality smoke: neutral, not a pass";
  const lines = [
    head,
    "",
    baseline
      ? `Against ${compareLabel} (${baseline.runId}, ${gate.matchedCases} matching cases at the same suite version).`
      : "No baseline yet; this run sets the numbers to beat.",
    "",
    "| suite | hard pass | judge mean | gate | p50 / p95 | $/1k answers |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of Object.values(report.suites)) {
    const cost = report.prices.configured ? `$${s.usdPer1kAnswers.toFixed(2)}` : "rates unset";
    lines.push(`| ${s.suite} | ${pct(s.hardCheckPassRate)} | ${s.judgeMean.toFixed(2)} | ${s.gateFailed ? "FAIL" : "pass"} | ${s.p50Ms}/${s.p95Ms} ms | ${cost} |`);
  }
  lines.push("");
  const standins = Object.entries(report.paths).filter(([, p]) => !p.live).map(([s]) => s);
  lines.push(standins.length === 0 ? "All suites ran on live code paths." : `Stand-in paths (package not merged yet): ${standins.join(", ")}.`);
  lines.push(`Judge ${report.judge.live ? "live" : "stand-in"}, agreement ${Math.round(report.calibration.agreement * 100)}% on ${report.calibration.provisional ? "provisional" : "hand"} labels.`);
  lines.push(`DNS ${report.dns}. Holdout ${report.holdout.configured ? "ran" : `did not run (${report.holdout.reason ?? "unconfigured"})`}.`);
  lines.push(report.eligibility.eligible ? "Gate-eligible." : `Not gate-eligible: ${report.eligibility.reasons.join("; ")}.`);
  if (gate.status !== "pass") {
    lines.push("", gate.status === "fail" ? "Failing because:" : "Neutral because:");
    for (const r of gate.reasons) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

export interface HistoryRow {
  runId: string;
  startedAt: string;
  gitSha: string | null;
  caseCount: number;
  gateFailed: boolean;
  calibration: RunReport["calibration"];
  suites: Record<string, { version: number; cases: number; hardCheckPassRate: number; judgeMean: number; gateFailed: boolean; p50Ms: number; p95Ms: number; usdPer1kAnswers: number }>;
}

export function historyRow(report: RunReport): HistoryRow {
  return {
    runId: report.runId,
    startedAt: report.startedAt,
    gitSha: report.gitSha,
    caseCount: report.caseCount,
    gateFailed: report.gateFailed,
    calibration: report.calibration,
    suites: Object.fromEntries(Object.values(report.suites).map((s) => [s.suite, {
      version: s.version, cases: s.cases, hardCheckPassRate: s.hardCheckPassRate,
      judgeMean: s.judgeMean, gateFailed: s.gateFailed, p50Ms: s.p50Ms, p95Ms: s.p95Ms,
      usdPer1kAnswers: s.usdPer1kAnswers,
    }])),
  };
}

export interface NightlyStaging {
  eligible: boolean;
  publicDir: string;
  privateRunDir: string;
  diagnosticPath: string | null;
}

// Stages a nightly run for upload. The full report and per-case data always
// land under private/. Only a complete, live, calibrated run becomes the
// public latest.json; anything else is kept as a private diagnostic.
export function writeNightlyStaging(root: string, report: RunReport, results: CaseResult[]): NightlyStaging {
  const publicDir = join(root, "public");
  const privateRunDir = join(root, "private", "runs", report.runId);
  mkdirSync(publicDir, { recursive: true });
  writeRun(privateRunDir, report, results);
  if (!report.eligibility.eligible || report.gateFailed) {
    const diagnosticPath = join(root, "private", "diagnostics", `${report.runId}.json`);
    mkdirSync(join(root, "private", "diagnostics"), { recursive: true });
    writeFileSync(diagnosticPath, `${JSON.stringify({ report: publicReport(report), eligibility: report.eligibility }, null, 2)}\n`);
    return { eligible: false, publicDir, privateRunDir, diagnosticPath };
  }
  const pub = publicReport(report);
  writeFileSync(join(publicDir, "latest.json"), `${JSON.stringify(pub, null, 2)}\n`);
  let history: HistoryRow[] = [];
  const historyPath = join(publicDir, "history.json");
  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf8")) as HistoryRow[];
    } catch {
      history = [];
    }
  }
  history.push(historyRow(pub));
  writeFileSync(historyPath, `${JSON.stringify(history.slice(-90), null, 2)}\n`);
  return { eligible: true, publicDir, privateRunDir, diagnosticPath: null };
}
