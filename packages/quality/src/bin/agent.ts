// agent: score the text cases through Mano's agent on a local Engine and
// print the numbers, without recording anything.
// Usage: node --import ./src/register.ts src/bin/agent.ts [--smoke] [--out runs/agent]
// Needs META_MODEL_API_KEY and MANO_MODEL_BENCH_ID (the fallback's model);
// starts Engine and the agent itself with throwaway secrets.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startAgentStack } from "../agent-stack.ts";
import { runAgentStage } from "../agent-stage.ts";
import { loadAgentPaths } from "../paths.ts";
import { SMOKE_CASE_IDS } from "../smoke.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const out = arg("--out") ?? "runs/agent";
const stack = await startAgentStack(process.env);
try {
  const env = { ...process.env, QUALITY_AGENT_URL: stack.agentUrl, MANO_AGENT_SECRET: stack.agentSecret, MANO_HANDLE_GRANT_SECRET: stack.grantSecret };
  const { summary, results } = await runAgentStage(await loadAgentPaths(env), {
    env,
    ...(process.argv.includes("--smoke") ? { onlyCaseIds: new Set(SMOKE_CASE_IDS) } : {}),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "agent.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(out, "agent-cases.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`agent: ${summary.cases} cases, ${summary.agentAnswered} by the agent, ${summary.fallbackAnswered} by the fallback, ${summary.answerErrors} unanswered, p50/p95 ${summary.p50Ms}/${summary.p95Ms} ms`);
  for (const s of Object.values(summary.suites)) {
    const t = s.traits;
    console.log(`${s.suite}: ${s.agentAnswered}/${s.cases} by the agent, hard ${(s.hardCheckPassRate * 100).toFixed(1)}%, judge ${s.judgeMean.toFixed(2)}${t ? ` (helpful ${t.helpful.toFixed(2)}, accurate ${t.accurate.toFixed(2)}, plain ${t.plain.toFixed(2)}, warm ${t.warm.toFixed(2)})` : ""}, p50/p95 ${s.p50Ms}/${s.p95Ms} ms${s.gateFailures.length > 0 ? `, safety: ${s.gateFailures.map((f) => `${f.caseId} (${f.check})`).join(", ")}` : ""}`);
  }
} finally {
  stack.stop();
}
