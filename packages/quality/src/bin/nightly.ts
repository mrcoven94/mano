// nightly: run every suite and stage public/private output for R2. Only a
// complete, live, calibrated run with a verified holdout becomes the public
// latest.json; anything else is kept as a private diagnostic and fails.
// Usage: node src/bin/nightly.ts [--out runs] [--date 2026-10-28]

import { execFileSync } from "node:child_process";
import { dnsFromEnv } from "../links.ts";
import { finishReport, runBench } from "../run.ts";
import { writeNightlyStaging } from "../report.ts";

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
const root = arg("--out") ?? "runs";
const day = arg("--date") ?? startedAt.slice(0, 10);

const { report, results, paths, judge, skippedSuites, expectedCaseIds } = await runBench({
  suites: ["chat", "text", "letters", "safety", "safety-holdout"],
});
const finishedAt = new Date().toISOString();
const full = finishReport(report, {
  runId: day, startedAt, finishedAt, gitSha: gitSha(), broken: false,
  paths, judge, dns: dnsFromEnv(process.env).mode, env: process.env,
}, { results, expectedCaseIds, requireHoldout: true });
const staging = writeNightlyStaging(root, full, results);
console.log(`nightly ${day}: ${full.caseCount} cases, gate ${full.gateFailed ? "FAIL" : "pass"}`);
if (skippedSuites.length > 0) console.log(`skipped suites: ${skippedSuites.join(", ")}`);
console.log(full.eligibility.eligible && !full.gateFailed
  ? `published ${staging.publicDir}/latest.json`
  : `diagnostic only: ${staging.diagnosticPath} (${full.eligibility.reasons.join("; ")})`);
if (!staging.eligible) process.exitCode = 1;
