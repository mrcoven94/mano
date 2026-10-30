// The nightly's agent stage: every text case (not letters or photos) answered
// through Mano's agent on a local Engine (agent-stack.ts), scored with the
// same checks and judge as the plain text line. It reports how many answers
// came from the agent and how many from the plain fallback, per suite, so
// "the agent" never silently means the fallback. It is recorded, not gated,
// until a main run of it becomes a baseline.

import { needsMailReader, type PathSet } from "./paths.ts";
import { percentile, runBench, type CaseResult, type RunOptions, type SuiteScore } from "./run.ts";
import { buildAllSuites } from "./suites/build.ts";

export interface AgentSuite {
  suite: string;
  cases: number;
  agentAnswered: number;
  fallbackAnswered: number;
  hardCheckPassRate: number;
  judgeMean: number;
  traits: SuiteScore["traits"] | null;
  gateFailures: { caseId: string; check: string }[];
  p50Ms: number;
  p95Ms: number;
}

export interface AgentSummary {
  ran: boolean;
  detail: string;
  cases: number;
  agentAnswered: number;
  fallbackAnswered: number;
  // Answered by the worker itself, with no responder (STOP).
  workerAnswered: number;
  answerErrors: number;
  suites: Record<string, AgentSuite>;
  p50Ms: number;
  p95Ms: number;
}

export function agentNotRun(detail: string): AgentSummary {
  return { ran: false, detail, cases: 0, agentAnswered: 0, fallbackAnswered: 0, workerAnswered: 0, answerErrors: 0, suites: {}, p50Ms: 0, p95Ms: 0 };
}

export function textCaseIds(onlyCaseIds?: Set<string>): string[] {
  return buildAllSuites()
    .flatMap((b) => b.cases)
    .filter((c) => !needsMailReader(c) && (!onlyCaseIds || onlyCaseIds.has(c.id)))
    .map((c) => c.id);
}

// The summary is aggregates only; the per-case results go to the private
// bucket with the rest of the run.
export async function runAgentStage(pathSet: PathSet | null, opts: RunOptions = {}): Promise<{ summary: AgentSummary; results: CaseResult[] }> {
  if (!pathSet) return { summary: agentNotRun("no agent configured (QUALITY_AGENT_URL, MANO_AGENT_SECRET, MANO_HANDLE_GRANT_SECRET)"), results: [] };
  const ids = textCaseIds(opts.onlyCaseIds);
  const bench = await runBench({ ...opts, pathSet, onlyCaseIds: new Set(ids), skipCalibration: true });
  const suites: Record<string, AgentSuite> = {};
  for (const [name, s] of Object.entries(bench.report.suites)) {
    const rows = bench.results.filter((r) => r.suite === name);
    suites[name] = {
      suite: name,
      cases: s.cases,
      agentAnswered: rows.filter((r) => r.answer.servedBy === "agent").length,
      fallbackAnswered: rows.filter((r) => r.answer.servedBy === "fallback").length,
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
    workerAnswered: bench.results.filter((r) => r.answer.servedBy === "worker").length,
    answerErrors: bench.results.filter((r) => r.checks.some((c) => c.id === "answer-error")).length,
    suites,
    p50Ms: percentile(latency, 50),
    p95Ms: percentile(latency, 95),
  };
  return { summary, results: bench.results };
}
