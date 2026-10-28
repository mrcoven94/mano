// bench: run suites through their answer paths and write a run folder.
// Usage: node src/bin/bench.ts [--suite chat] [--broken] [--out runs/local]

import { execFileSync } from "node:child_process";
import { dnsFromEnv } from "../links.ts";
import { finishReport, runBench } from "../run.ts";
import { writeRun } from "../report.ts";
import { SUITE_NAMES } from "../suites/build.ts";

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
const suiteArg = arg("--suite");
const out = arg("--out") ?? `runs/${startedAt.slice(0, 10)}-local`;
const broken = process.argv.includes("--broken");

if (process.argv.includes("--list")) {
  console.log(SUITE_NAMES.join("\n"));
  process.exit(0);
}

const { report, results, paths, judge } = await runBench({
  suites: suiteArg ? [suiteArg] : undefined,
  broken,
});
const finishedAt = new Date().toISOString();
const full = finishReport(report, {
  runId: `${startedAt.slice(0, 10)}-local`,
  startedAt, finishedAt, gitSha: gitSha(), broken,
  paths, judge, dns: dnsFromEnv(process.env).mode, env: process.env,
});
writeRun(out, full, results);
for (const s of Object.values(full.suites)) {
  console.log(`${s.suite}: hard ${(s.hardCheckPassRate * 100).toFixed(1)}% judge ${s.judgeMean.toFixed(2)} gate ${s.gateFailed ? "FAIL" : "pass"} p50/p95 ${s.p50Ms}/${s.p95Ms}ms $${s.usdPer1kAnswers.toFixed(2)}/1k`);
}
console.log(`judge ${full.judge.id} agreement ${Math.round(full.calibration.agreement * 100)}% kept=${full.calibration.kept}`);
console.log(`wrote ${out}`);
if (full.gateFailed) process.exitCode = 1;
