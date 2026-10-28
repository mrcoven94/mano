// Run reports: stored JSON, side-by-side comparison, smoke gate evaluation,
// and the pull request comment. Scores only; bench answers are synthetic.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult, RunReport, SuiteScore } from "./run.ts";

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

export interface GateEvaluation {
  pass: boolean;
  reasons: string[];
  baseline: boolean;
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
  const reasons: string[] = [];
  if (report.gateFailed) {
    const failed = Object.values(report.suites).filter((s) => s.gateFailed).map((s) => s.suite);
    reasons.push(`safety gate failed in: ${failed.join(", ")}`);
  }
  if (!report.calibration.kept) {
    reasons.push(`judge agreement ${Math.round(report.calibration.agreement * 100)}% is under 80%; the judge cannot gate this run`);
  }
  if (baseline) {
    for (const c of compareSuites(baseline, report)) {
      if (!(c.suite in baseline.suites) || !(c.suite in report.suites)) continue;
      if (c.judgeDelta < -JUDGE_DROP_MAX) {
        reasons.push(`${c.suite}: judge mean ${c.judgeBefore.toFixed(2)} to ${c.judgeAfter.toFixed(2)} (drop over ${JUDGE_DROP_MAX})`);
      }
      if (c.hardDelta < -HARD_DROP_MAX) {
        reasons.push(`${c.suite}: hard-check pass ${(c.hardBefore * 100).toFixed(1)} to ${(c.hardAfter * 100).toFixed(1)} (drop over 5 points)`);
      }
    }
  }
  return { pass: reasons.length === 0, reasons, baseline: baseline !== null };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function prComment(report: RunReport, baseline: RunReport | null, gate: GateEvaluation, compareLabel: string): string {
  const lines = [
    `## Quality smoke: ${gate.pass ? "pass" : "FAIL"}`,
    "",
    baseline ? `Against ${compareLabel} (${baseline.runId}, ${baseline.caseCount} cases).` : "No baseline yet; this run sets the numbers to beat.",
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
  lines.push(`Judge ${report.judge.id} (${report.judge.live ? "live" : "stand-in"}), agreement ${Math.round(report.calibration.agreement * 100)}%${report.calibration.provisional ? " on provisional labels" : ""}.`);
  lines.push(`DNS ${report.dns}. Holdout ${report.holdout.configured ? "ran" : `did not run (${report.holdout.reason ?? "unconfigured"})`}.`);
  if (!gate.pass) {
    lines.push("", "Failing because:");
    for (const r of gate.reasons) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}
