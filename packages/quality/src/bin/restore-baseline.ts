// restore-baseline: puts a past main run back as the baseline pull requests
// are gated against, on purpose, and logs it in baseline-log.json. Run from
// the quality-nightly workflow (input restore_from_run) on main only.
// Usage: node --import ./src/register.ts src/bin/restore-baseline.ts --run <runId> --ref "$GITHUB_REF" [--accept-baseline] [--out dir]
// The run's full report comes from mano-quality-private runs/<runId>/report.json.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { r2CredsFromEnv, r2GetJson, PRIVATE_BUCKET } from "../r2.ts";
import { restoreBaseline, type BaselineLogEntry, type HistoryRow } from "../report.ts";
import type { RunReport } from "../run.ts";
import { readPublic, uploadStaging } from "../sync.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const runId = arg("--run") ?? "";
const ref = arg("--ref") ?? "local";
if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]+)?$/.test(runId)) throw new Error("--run must be a run id such as 2026-10-31-41020000000");
const creds = r2CredsFromEnv(process.env);
if (!creds) throw new Error("R2 credentials are required");
const report = await r2GetJson<RunReport>(creds, PRIVATE_BUCKET, `runs/${runId}/report.json`);
if (!report) throw new Error(`no main run ${runId} in mano-quality-private; it cannot be restored`);
// The baseline the run actually produced, when it was kept with the run.
const effective = await r2GetJson<RunReport>(creds, PRIVATE_BUCKET, `runs/${runId}/baseline.json`);
const priorLog = (await readPublic<BaselineLogEntry[]>(creds, "baseline-log.json")) ?? [];
const current = await readPublic<RunReport>(creds, "baseline.json");
const latest = await readPublic<RunReport>(creds, "latest.json");
const history = (await readPublic<HistoryRow[]>(creds, "history.json")) ?? [];
const root = arg("--out") ?? mkdtempSync(`${tmpdir()}/restore-`);
restoreBaseline(root, { report, effective }, { ref, actor: process.env.GITHUB_ACTOR ?? null, priorLog, current, latest, history, accept: process.argv.includes("--accept-baseline") });
const sent = await uploadStaging(root, creds);
console.log(`restored run ${runId} (${report.gitSha?.slice(0, 7) ?? "no sha"}) as the baseline; wrote ${sent.map((s) => s.key).join(", ")}`);
