// smoke: run the 25-case smoke subset and gate it against a baseline.
// Usage: node src/bin/smoke.ts [--baseline runs/main/report.json] [--out runs/smoke] [--broken]
// Prints the PR comment to stdout and exits 1 when the gate fails.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dnsFromEnv } from "../links.ts";
import { finishReport, runBench, type RunReport } from "../run.ts";
import { evalGate, prComment, writeRun } from "../report.ts";
import { SMOKE_CASE_IDS } from "../smoke.ts";

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
const broken = process.argv.includes("--broken");

let baseline: RunReport | null = null;
if (baselinePath) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as RunReport;
  } catch {
    console.error(`note: no readable baseline at ${baselinePath}; gating on safety only`);
  }
}

const { report, results, paths, judge } = await runBench({ broken, onlyCaseIds: new Set(SMOKE_CASE_IDS) });
const finishedAt = new Date().toISOString();
const full = finishReport(report, {
  runId: `smoke-${startedAt.slice(0, 16).replace(/[-:T]/g, "")}`,
  startedAt, finishedAt, gitSha: gitSha(), broken,
  paths, judge, dns: dnsFromEnv(process.env).mode, env: process.env,
});
writeRun(out, full, results);
const gate = evalGate(full, baseline);
console.log(prComment(full, baseline, gate, "main's last nightly run"));
if (!gate.pass) {
  console.error(`smoke gate FAILED: ${gate.reasons.join("; ")}`);
  process.exitCode = 1;
}
