// smoke: the pull request gate. Runs the 28-case smoke subset and the persona
// probes through the real text line, then gates against main's baseline
// (the last gate-eligible nightly run, from R2 or --baseline).
// Usage: node --import ./src/register.ts src/bin/smoke.ts [--baseline file] [--out runs/smoke]
// Writes report.json, cases.json, gate.json and comment.md to --out and
// exits 0 whatever the gate says; src/bin/smoke-publish.ts posts the result
// and sets the job's outcome. Any other exit means the run itself broke.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dnsFromEnv } from "../links.ts";
import { runProbes } from "../probes.ts";
import { r2CredsFromEnv } from "../r2.ts";
import { evalGate, prComment, writeRun } from "../report.ts";
import { finishReport, runBench, type RunReport } from "../run.ts";
import { SMOKE_CASE_IDS } from "../smoke.ts";
import { readPublic } from "../sync.ts";
import { textLineFromEnv } from "../textline.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const startedAt = new Date().toISOString();
const baselinePath = arg("--baseline");
const out = arg("--out") ?? "runs/smoke";

let baseline: RunReport | null = null;
let baselineFrom = "no baseline";
if (baselinePath) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as RunReport;
    baselineFrom = baselinePath;
  } catch {
    console.error(`note: no readable baseline at ${baselinePath}`);
  }
} else {
  const creds = r2CredsFromEnv(process.env);
  if (creds) {
    baseline = await readPublic<RunReport>(creds, "baseline.json");
    baselineFrom = baseline ? "main's last gate-eligible nightly run" : "no nightly baseline in R2 yet";
  }
}

const bench = await runBench({ onlyCaseIds: new Set(SMOKE_CASE_IDS) });
const probes = await runProbes(textLineFromEnv(process.env));
const full = finishReport(bench.report, {
  runId: `smoke-${startedAt.slice(0, 16).replace(/[-:T]/g, "")}`,
  startedAt, finishedAt: new Date().toISOString(), gitSha: gitSha(), broken: false,
  paths: bench.paths, judge: bench.judge, dns: dnsFromEnv(process.env).mode, env: process.env,
}, { results: bench.results, expectedCaseIds: bench.expectedCaseIds, judgeErrors: bench.judgeErrors, answeringModel: bench.answeringModel });
full.probes = probes;
if (bench.skippedSuites.length > 0) full.eligibility = { eligible: false, reasons: [...full.eligibility.reasons, `suites skipped: ${bench.skippedSuites.join(", ")}`] };

writeRun(out, full, bench.results);
for (const r of bench.results) {
  for (const c of r.checks.filter((x) => x.id === "answer-error")) console.error(`answer error on ${r.caseId}: ${c.detail}`);
}
const gate = evalGate(full, baseline);
const comment = prComment(full, baseline, gate, baselineFrom);
writeFileSync(join(out, "gate.json"), `${JSON.stringify({ status: gate.status, reasons: gate.reasons, matchedCases: gate.matchedCases }, null, 2)}\n`);
writeFileSync(join(out, "comment.md"), `${comment}\n`);
console.log(comment);
