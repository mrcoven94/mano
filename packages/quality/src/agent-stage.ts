// The nightly's agent stage: every text case (not letters or photos) answered
// through Mano's agent on a local Engine (agent-stack.ts), scored with the
// same checks and judge as the plain text line. It reports how many answers
// came from the agent and how many from the plain fallback, per suite, so
// "the agent" never silently means the fallback. It is recorded, not gated,
// until a main run of it becomes a baseline.

import { startAgentStack, type AgentStack } from "./agent-stack.ts";
import { FakeJudge, MetaJudge, type JudgeClient } from "./judge.ts";
import { DEFAULT_MODEL_BASE_URL, MetaModelClient, judgeClientFromEnv } from "./models.ts";
import { loadAgentPaths, needsMailReader, type PathSet } from "./paths.ts";
import { agentAsReport } from "./report.ts";
import { calibrate, fingerprintsOf, percentile, rerunNewlyFailing, runBench, type CaseResult, type RunOptions } from "./run.ts";
import { buildAllSuites } from "./suites/build.ts";

export type { AgentSuite, AgentSummary } from "./agent-types.ts";
import type { AgentSummary, AgentSuite } from "./agent-types.ts";

export function agentNotRun(detail: string): AgentSummary {
  return { ran: false, detail, cases: 0, agentAnswered: 0, fallbackAnswered: 0, mixedAnswered: 0, workerAnswered: 0, answerErrors: 0, suites: {}, p50Ms: 0, p95Ms: 0 };
}

export function textCaseIds(onlyCaseIds?: Set<string>): string[] {
  return buildAllSuites()
    .flatMap((b) => b.cases)
    .filter((c) => !needsMailReader(c) && (!onlyCaseIds || onlyCaseIds.has(c.id)))
    .map((c) => c.id);
}

// The summary is aggregates only; the per-case results go to the private
// bucket with the rest of the run.
// With main's agent record as the baseline, a case that newly fails is run
// once more and counts only if it fails again, as on the plain line.
export async function runAgentStage(pathSet: PathSet | null, opts: RunOptions = {}, baseline?: AgentSummary): Promise<{ summary: AgentSummary; results: CaseResult[] }> {
  if (!pathSet) return { summary: agentNotRun("no agent configured (QUALITY_AGENT_URL, MANO_AGENT_SECRET, MANO_HANDLE_GRANT_SECRET)"), results: [] };
  const ids = textCaseIds(opts.onlyCaseIds);
  const first = await runBench({ ...opts, pathSet, onlyCaseIds: new Set(ids), skipCalibration: true });
  const { bench, rerun } = await rerunNewlyFailing(first, baseline ? agentAsReport(baseline) : null, { ...opts, pathSet });
  const suites: Record<string, AgentSuite> = {};
  for (const [name, s] of Object.entries(bench.report.suites)) {
    const rows = bench.results.filter((r) => r.suite === name);
    suites[name] = {
      suite: name,
      cases: s.cases,
      agentAnswered: rows.filter((r) => r.answer.servedBy === "agent").length,
      fallbackAnswered: rows.filter((r) => r.answer.servedBy === "fallback").length,
      mixedAnswered: rows.filter((r) => r.answer.servedBy === "mixed").length,
      hardCheckPassRate: s.hardCheckPassRate,
      judgeMean: s.judgeMean,
      traits: s.traits ?? null,
      gateFailures: s.gateFailures.map((f) => ({ caseId: f.caseId, check: f.check })),
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
    };
  }
  const latency = bench.results.map((r) => r.latencyMs);
  const summary: AgentSummary = {
    ran: true,
    detail: "text cases through Mano's agent on a local Engine",
    cases: bench.results.length,
    agentAnswered: bench.results.filter((r) => r.answer.servedBy === "agent").length,
    fallbackAnswered: bench.results.filter((r) => r.answer.servedBy === "fallback").length,
    mixedAnswered: bench.results.filter((r) => r.answer.servedBy === "mixed").length,
    workerAnswered: bench.results.filter((r) => r.answer.servedBy === "worker").length,
    answerErrors: bench.results.filter((r) => r.checks.some((c) => c.id === "answer-error")).length,
    suites,
    p50Ms: percentile(latency, 50),
    p95Ms: percentile(latency, 95),
  };
  const fps = fingerprintsOf(bench.results, bench.report.suites);
  summary.fingerprints = Object.fromEntries(bench.results.filter((r) => fps[r.caseId]).map((r) => [r.caseId, { ...fps[r.caseId]!, live: fps[r.caseId]!.live === true, servedBy: r.answer.servedBy ?? "plain" }]));
  summary.rerun = rerun;
  return { summary, results: bench.results };
}

// The model apps/agent calls on every turn (STANDARD_MODEL_ID in
// apps/agent/agent/lib/muse.ts; a test keeps the two equal).
export const AGENT_MODEL_ID = "muse-spark-1.3";

const family = (id: string) => id.replace(/-contributor$/i, "").toLowerCase();

// The agent stage's judge: MANO_MODEL_AGENT_JUDGE_ID when set (a Standard
// Meta model other than the agent's), otherwise the bench judge. If that is
// the agent's or the fallback's model, the scores are marked self-judged.
export function agentJudgeFromEnv(env: NodeJS.ProcessEnv): { judge: JudgeClient; models: { agent: string; fallback: string; judge: string }; selfJudged: boolean } {
  const fallback = env.MANO_MODEL_BENCH_ID ?? "";
  const own = env.MANO_MODEL_AGENT_JUDGE_ID ?? "";
  if (/-contributor$/i.test(own)) throw new Error("the agent's judge must run on a Standard model ID, not a -contributor one");
  let judge: JudgeClient;
  if (own && env.META_MODEL_API_KEY) {
    judge = new MetaJudge(new MetaModelClient(own, env.MANO_MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL, env.META_MODEL_API_KEY));
  } else {
    const client = judgeClientFromEnv(env);
    judge = client.live ? new MetaJudge(client) : new FakeJudge();
  }
  const judgeId = judge.id.replace(/^judge:/, "");
  const selfJudged = [AGENT_MODEL_ID, fallback].filter(Boolean).some((m) => family(m) === family(judgeId));
  return { judge, models: { agent: AGENT_MODEL_ID, fallback, judge: judgeId }, selfJudged };
}

export interface StageDeps {
  start?: (env: NodeJS.ProcessEnv) => Promise<AgentStack>;
  load?: (env: NodeJS.ProcessEnv) => Promise<PathSet | null>;
}

// The agent stage is optional: whatever goes wrong in it (the stack does not
// start, a turn throws), the nightly still stages and uploads the primary
// results. The reason recorded is a fixed phrase, never an error message,
// which could carry a URL or a secret. The stack is always stopped.
export async function runAgentStageSafely(env: NodeJS.ProcessEnv, deps: StageDeps = {}, opts: RunOptions = {}, baseline?: AgentSummary): Promise<{ summary: AgentSummary; results: CaseResult[] }> {
  let stack: AgentStack;
  try {
    stack = await (deps.start ?? startAgentStack)(env);
  } catch (err) {
    console.error(`agent stage: could not start (${err instanceof Error ? err.name : "error"})`);
    return { summary: agentNotRun("the agent stage could not start Engine and the agent"), results: [] };
  }
  try {
    const stageEnv = { ...env, QUALITY_AGENT_URL: stack.agentUrl, MANO_AGENT_SECRET: stack.agentSecret, MANO_HANDLE_GRANT_SECRET: stack.grantSecret };
    const { judge, models, selfJudged } = agentJudgeFromEnv(stageEnv);
    const out = await runAgentStage(await (deps.load ?? loadAgentPaths)(stageEnv), { ...opts, env: stageEnv, judge }, baseline);
    // The agent's judge may not be the bench's, so it is calibrated on its own.
    const cal = await calibrate(judge);
    return { summary: { ...out.summary, models, selfJudged, calibration: { agreement: cal.agreement, complete: cal.complete, kept: cal.kept } }, results: out.results };
  } catch (err) {
    console.error(`agent stage: failed while running (${err instanceof Error ? err.name : "error"})`);
    return { summary: agentNotRun("the agent stage failed while running"), results: [] };
  } finally {
    await stack.stop();
  }
}
