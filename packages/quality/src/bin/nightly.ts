// nightly: run every suite through the real answer paths, the persona
// probes, Guardian against production and mail's deadline accuracy, then
// record the run with its history. With --upload and R2 credentials the run
// lands in R2 (mano-quality for aggregates, mano-quality-private for per-case
// results); otherwise it stays in --out.
// Usage: node --import ./src/register.ts src/bin/nightly.ts [--out runs-staging] [--date 2026-10-29] [--upload]
// Exits 1 when a safety check failed, after the run is recorded.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runGuardian } from "../guardian.ts";
import { dnsFromEnv } from "../links.ts";
import { scoreMailDeadlines } from "../mail.ts";
import { runProbes } from "../probes.ts";
import { r2CredsFromEnv } from "../r2.ts";
import { evalGate, readHistory, writeNightlyStaging, type HistoryRow } from "../report.ts";
import { finishReport, runBench } from "../run.ts";
import { readPublic, uploadStaging } from "../sync.ts";
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
const root = arg("--out") ?? "runs-staging";
const day = arg("--date") ?? startedAt.slice(0, 10);
const upload = process.argv.includes("--upload");
const creds = r2CredsFromEnv(process.env);
if (upload && !creds) throw new Error("--upload needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ACCOUNT_ID or R2_ENDPOINT");

const prior: HistoryRow[] = upload && creds
  ? ((await readPublic<HistoryRow[]>(creds, "history.json")) ?? [])
  : readHistory(join(root, "public", "history.json"));

const bench = await runBench({ suites: ["chat", "text", "letters", "safety", "safety-holdout", "personas"] });
console.log(`bench: ${bench.results.length} cases answered`);
const probes = await runProbes(textLineFromEnv(process.env));
console.log(`probes: ${probes.passed}/${probes.total}`);
const guardian = await runGuardian(process.env);
console.log(guardian.ran ? `guardian: precision ${guardian.precision.toFixed(3)} recall ${guardian.recall.toFixed(3)}` : `guardian: not run (${guardian.detail})`);
const mail = await scoreMailDeadlines();

const full = finishReport(bench.report, {
  runId: day, startedAt, finishedAt: new Date().toISOString(), gitSha: gitSha(), broken: false,
  paths: bench.paths, judge: bench.judge, dns: dnsFromEnv(process.env).mode, env: process.env,
}, { results: bench.results, expectedCaseIds: bench.expectedCaseIds, judgeErrors: bench.judgeErrors, answeringModel: bench.answeringModel });
full.probes = probes;
full.guardian = guardian;
full.mail = mail;
if (!mail.live) full.standins = [...(full.standins ?? []), `mail deadlines: ${mail.detail}`];
if (!guardian.ran) full.standins = [...(full.standins ?? []), `guardian: ${guardian.detail}`];

const staging = writeNightlyStaging(root, full, bench.results, prior);
for (const s of Object.values(full.suites)) {
  const t = s.traits;
  console.log(
    `${s.suite} v${s.version}: ${s.liveCases}/${s.cases} live, hard ${(s.hardCheckPassRate * 100).toFixed(1)}%, judge ${s.judgeMean.toFixed(2)}` +
      (t ? ` (helpful ${t.helpful.toFixed(2)}, accurate ${t.accurate.toFixed(2)}, plain ${t.plain.toFixed(2)}, warm ${t.warm.toFixed(2)})` : "") +
      `, safety gate ${s.gateFailed ? `FAIL (${s.gateFailures.length})` : "pass"}, p50/p95 ${s.p50Ms}/${s.p95Ms} ms` +
      (s.firstTextP50Ms !== undefined ? `, first text ${s.firstTextP50Ms}/${s.firstTextP95Ms} ms, guard changed ${((s.guardChangeRate ?? 0) * 100).toFixed(1)}%` : "") +
      `, ${full.prices.configured ? `$${s.usdPer1kAnswers.toFixed(2)}/1k` : "rates unset"}`,
  );
}
console.log(`probes: ${probes.passed}/${probes.total} passed (${probes.slowOnly} only too slow), crisis safe ${probes.crisisPassed}/${probes.crisisTotal}, guard changed ${(probes.guardChangeRate * 100).toFixed(1)}%, first text p50/p95 ${probes.firstTextP50Ms}/${probes.firstTextP95Ms} ms`);
if (probes.failures.length > 0) console.log(`probe failures: ${probes.failures.map((f) => `${f.id} (${f.failed.join(", ")})`).join("; ")}`);
if (guardian.ran) console.log(`guardian: ${guardian.cases} cases, precision ${guardian.precision.toFixed(3)} (TP ${guardian.truePositives}, FP ${guardian.falsePositives}), recall ${guardian.recall.toFixed(3)} (FN ${guardian.falseNegatives}), p50/p95 ${guardian.p50Ms}/${guardian.p95Ms} ms, warm-up ${guardian.warmSeconds} s`);
console.log(`mail deadlines: ${mail.correct}/${mail.letters} (${mail.live ? "live" : mail.detail})`);
console.log(`judge ${full.judge.live ? "live" : "stand-in"}, calibration ${Math.round(full.calibration.agreement * 100)}% on ${full.calibration.provisional ? "provisional" : "hand"} labels, ${full.judge.errors ?? 0} unscored`);
for (const s of full.standins ?? []) console.log(`stand-in: ${s}`);
console.log(full.eligibility.eligible ? "gate-eligible: this run becomes the baseline" : `not gate-eligible: ${full.eligibility.reasons.join("; ")}`);
console.log(`staged ${staging.publicDir} and ${staging.privateRunDir}`);

if (upload && creds) {
  const sent = await uploadStaging(root, creds);
  console.log(`uploaded ${sent.length} objects to R2`);
}
const gate = evalGate(full, null);
if (gate.status === "fail") {
  console.error(`safety failures: ${gate.reasons.join("; ")}`);
  process.exitCode = 1;
}
