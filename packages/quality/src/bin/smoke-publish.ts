// smoke-publish: posts runs/smoke to the pull request and sets the job's
// outcome. Usage (CI): node --import ./src/register.ts src/bin/smoke-publish.ts runs/smoke
// Needs GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and HEAD_SHA in the environment.

import { exitCodeFor, publishSmoke, readOutcome } from "../publish.ts";

const dir = process.argv[2] ?? "runs/smoke";
const outcome = readOutcome(dir);
const token = process.env.GH_TOKEN ?? "";
const repo = process.env.GITHUB_REPOSITORY ?? "";
const pr = Number(process.env.PR_NUMBER ?? "");
const sha = process.env.HEAD_SHA ?? "";
if (!token || !repo || !Number.isInteger(pr) || pr <= 0 || !sha) throw new Error("GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and HEAD_SHA are required");
const posted = await publishSmoke(outcome, { repo, pr, sha, token });
console.log(`quality gate ${outcome.status}: comment ${posted.commentId} ${posted.edited ? "edited" : "created"}, check ${posted.conclusion}`);
for (const r of outcome.reasons) console.log(`- ${r}`);
process.exitCode = exitCodeFor(outcome.status);
