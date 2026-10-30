// agent: score the text cases through Mano's agent on a local Engine and
// print the numbers, without recording anything.
// Usage: node --import ./src/register.ts src/bin/agent.ts [--smoke] [--out runs/agent]
// Needs META_MODEL_API_KEY and MANO_MODEL_BENCH_ID (the fallback's model);
// starts Engine and the agent itself with throwaway secrets.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgentStageSafely } from "../agent-stage.ts";
import { SMOKE_CASE_IDS } from "../smoke.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const out = arg("--out") ?? "runs/agent";
const { summary, results } = await runAgentStageSafely(process.env, {}, process.argv.includes("--smoke") ? { onlyCaseIds: new Set(SMOKE_CASE_IDS) } : {});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "agent.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(out, "agent-cases.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(`agent: ${summary.ran ? "" : `not run (${summary.detail}) `}${summary.cases} cases, ${summary.agentAnswered} by the agent, ${summary.fallbackAnswered} by the fallback, ${summary.mixedAnswered} mixed, ${summary.answerErrors} unanswered, p50/p95 ${summary.p50Ms}/${summary.p95Ms} ms`);
if (summary.models) console.log(`models: agent ${summary.models.agent}, fallback ${summary.models.fallback}, judge ${summary.models.judge}${summary.selfJudged ? " (self-judged)" : ""}`);
for (const s of Object.values(summary.suites)) {
  const t = s.traits;
  console.log(`${s.suite}: ${s.agentAnswered}/${s.cases} by the agent, hard ${(s.hardCheckPassRate * 100).toFixed(1)}%, judge ${s.judgeMean.toFixed(2)}${t ? ` (helpful ${t.helpful.toFixed(2)}, accurate ${t.accurate.toFixed(2)}, plain ${t.plain.toFixed(2)}, warm ${t.warm.toFixed(2)})` : ""}, p50/p95 ${s.p50Ms}/${s.p95Ms} ms${s.gateFailures.length > 0 ? `, safety: ${s.gateFailures.map((f) => `${f.caseId} (${f.check})`).join(", ")}` : ""}`);
}
if (!summary.ran) process.exitCode = 1;
