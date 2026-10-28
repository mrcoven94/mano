// smoke: run the 25-case smoke subset and gate it against a baseline.
// Usage: node src/bin/smoke.ts [--baseline runs/main/latest.json] [--out runs/smoke] [--broken]
// Prints the PR comment to stdout. Exits 0 on pass, 1 on fail, 2 on neutral
// (not gate-eligible: stand-ins, no baseline, or provisional calibration).

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
    console.error(`note: no readable baseline at ${baselinePath}`);
  }
}

const { report, results, paths, judge, skippedSuites, expectedCaseIds } = await runBench({ broken, onlyCaseIds: new Set(SMOKE_CASE_IDS) });
if (skippedSuites.length > 0) {
  console.error(`requested suites skipped: ${skippedSuites.join(", ")}`);
  process.exitCode = 1;
}
const finishedAt = new Date().toISOString();
const full = finishReport(report, {
  runId: `smoke-${startedAt.slice(0, 16).replace(/[-:T]/g, "")}`,
  startedAt, finishedAt, gitSha: gitSha(), broken,
  paths, judge, dns: dnsFromEnv(process.env).mode, env: process.env,
}, { results, expectedCaseIds, requireHoldout: false });
writeRun(out, full, results);
const gate = evalGate(full, baseline);
console.log(prComment(full, baseline, gate, "main's last nightly run"));
if (gate.status === "fail") {
  console.error(`smoke gate FAILED: ${gate.reasons.join("; ")}`);
  process.exitCode = 1;
} else if (gate.status === "neutral") {
  console.error(`smoke gate NEUTRAL: ${gate.reasons.join("; ")}`);
  process.exitCode = 2;
}
