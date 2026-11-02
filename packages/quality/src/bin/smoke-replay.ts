// smoke-replay: runs the live smoke's code path on recorded synthetic
// replies (replay.ts) and needs no key. Usage:
// node --import ./src/register.ts src/bin/smoke-replay.ts [--out runs/smoke-replay]
// Writes report.json and cases.json to --out, adds the result to the job
// summary in CI, and exits 1 when any replayed case fails a check or a
// recording goes unused.

import { appendFileSync } from "node:fs";
import { writeRun } from "../report.ts";
import { replaySummary, runReplay } from "../replay.ts";

const i = process.argv.indexOf("--out");
const out = i === -1 ? "runs/smoke-replay" : process.argv[i + 1]!;
const outcome = await runReplay();
writeRun(out, outcome.report, outcome.results);
const summary = replaySummary(outcome);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
process.exitCode = outcome.status === "pass" ? 0 : 1;
