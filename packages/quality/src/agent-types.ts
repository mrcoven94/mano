// The agent stage's record, as types only, so the staff page's build can
// read reports without type-checking the code that starts the agent.
import type { SuiteScore } from "./run.ts";

export interface AgentSuite {
  suite: string;
  cases: number;
  agentAnswered: number;
  fallbackAnswered: number;
  // Some turns by the agent and some by the fallback; never counted as agent.
  mixedAnswered: number;
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
  // Who answered and who judged. When the judge is the agent's model or the
  // fallback's, its scores grade its own family and are marked self-judged.
  models?: { agent: string; fallback: string; judge: string };
  selfJudged?: boolean;
  // The agent's judge on the 30 labeled cases (provisional labels).
  calibration?: { agreement: number; complete: boolean; kept: boolean };
  cases: number;
  agentAnswered: number;
  fallbackAnswered: number;
  mixedAnswered: number;
  // Answered by the worker itself, with no responder (STOP).
  workerAnswered: number;
  answerErrors: number;
  suites: Record<string, AgentSuite>;
  p50Ms: number;
  p95Ms: number;
}

