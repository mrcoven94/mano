// Rescore: re-grades a stored run after a check changes. Hard checks re-run in
// code, judge scores are reused untouched, and no model call is made. The input
// run keeps its answers (synthetic bench data only) so the re-grade is exact.

import { runHardChecks } from "./checks.ts";
import { LocalDns } from "./links.ts";
import { attachJudgeGate, fingerprintsOf, scoreSuite, type CaseResult, type RunReport } from "./run.ts";
import { buildAllSuites } from "./suites/build.ts";
import type { BenchCase } from "./suites/types.ts";
import { readRun, writeRun } from "./report.ts";

export async function rescoreRun(inDir: string, outDir: string): Promise<RunReport> {
  const { report, results } = readRun(inDir);
  const byId = new Map<string, BenchCase>();
  for (const suite of buildAllSuites()) {
    for (const c of suite.cases) byId.set(c.id, c);
  }
  const dns = new LocalDns();
  const rescored: CaseResult[] = [];
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (!c) {
      rescored.push(r);
      continue;
    }
    // A stored answer error has nothing to re-check.
    if (r.checks.some((x) => x.id === "answer-error")) {
      rescored.push(r);
      continue;
    }
    const checks = await runHardChecks(
      c,
      {
        text: r.answer.text, bubbles: r.answer.bubbles, actions: r.answer.actions, latencyMs: r.latencyMs,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, ...(r.answer.route ? { route: r.answer.route } : {}),
        ...(r.answer.earlier ? { earlier: r.answer.earlier } : {}),
      },
      dns,
      { knowsCatalog: r.path?.knowsCatalog ?? true },
    );
    rescored.push({ ...r, checks });
  }
  attachJudgeGate(rescored);
  const suites: RunReport["suites"] = {};
  for (const build of buildAllSuites()) {
    const subset = rescored.filter((r) => r.suite === build.suite);
    if (subset.length > 0) suites[build.suite] = scoreSuite(build, subset, report.prices);
  }
  for (const [name, score] of Object.entries(report.suites)) {
    if (!(name in suites)) suites[name] = score;
  }
  const fingerprints = fingerprintsOf(rescored, suites);
  const out: RunReport = {
    ...report,
    runId: `${report.runId}-rescored`,
    finishedAt: new Date().toISOString(),
    suites,
    fingerprints,
    gateFailed: Object.values(suites).some((s) => s.gateFailed),
  };
  writeRun(outDir, out, rescored);
  return out;
}
