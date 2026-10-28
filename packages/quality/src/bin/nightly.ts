// nightly: run every suite and stage a run folder for R2 (bucket mano-quality,
// one folder per run). Also refreshes latest.json and history.json in the
// staging root. Usage: node src/bin/nightly.ts [--out runs] [--date 2026-10-28]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dnsFromEnv } from "../links.ts";
import { finishReport, runBench } from "../run.ts";
import { writeRun } from "../report.ts";

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
const dir = join(root, day);

const { report, results, paths, judge } = await runBench({});
const finishedAt = new Date().toISOString();
const full = finishReport(report, {
  runId: day, startedAt, finishedAt, gitSha: gitSha(), broken: false,
  paths, judge, dns: dnsFromEnv(process.env).mode, env: process.env,
});
writeRun(dir, full, results);

mkdirSync(root, { recursive: true });
writeFileSync(join(root, "latest.json"), `${JSON.stringify(full, null, 2)}\n`);
let history: unknown[] = [];
const historyPath = join(root, "history.json");
if (existsSync(historyPath)) {
  try {
    history = JSON.parse(readFileSync(historyPath, "utf8")) as unknown[];
  } catch {
    history = [];
  }
}
history.push({
  runId: full.runId, startedAt: full.startedAt, gitSha: full.gitSha, caseCount: full.caseCount,
  gateFailed: full.gateFailed, calibration: full.calibration,
  suites: Object.fromEntries(Object.values(full.suites).map((s) => [s.suite, {
    version: s.version, cases: s.cases, hardCheckPassRate: s.hardCheckPassRate,
    judgeMean: s.judgeMean, gateFailed: s.gateFailed, p50Ms: s.p50Ms, p95Ms: s.p95Ms,
    usdPer1kAnswers: s.usdPer1kAnswers,
  }])),
});
writeFileSync(historyPath, `${JSON.stringify(history.slice(-90), null, 2)}\n`);
console.log(`nightly ${day}: ${full.caseCount} cases, gate ${full.gateFailed ? "FAIL" : "pass"}`);
console.log(`staged ${dir}, latest.json, history.json (${history.length} runs)`);
