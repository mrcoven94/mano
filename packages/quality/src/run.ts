// Bench runner. Answers every case through its answer path, runs the hard
// checks, batches the judge, and scores each suite. Run with:
// node src/bin/bench.ts [--suite chat] [--broken]

import { calibrationFacts, buildCalibrationSet, agreement, CALIBRATION_LABELS_PROVISIONAL } from "./calibration.ts";
import { gateFailures, hardCheckPassRate, runHardChecks, type CheckResult } from "./checks.ts";
import { dnsFromEnv, type DnsClient } from "./links.ts";
import { assertJudgeServingDiffer, judgeClientFromEnv } from "./models.ts";
import { FakeJudge, JUDGE_AGREEMENT_MIN, MetaJudge, judgeAll, judgeMean, type JudgeClient, type JudgeScore } from "./judge.ts";
import { buildHoldoutSuite } from "./suites/holdout-suite.ts";
import { loadHoldout } from "./holdout.ts";
import { loadAllAnswerPaths, type BenchAnswer } from "./paths.ts";
import { buildAllSuites, buildSuite } from "./suites/build.ts";
import type { BenchCase, SuiteBuild, SuiteName } from "./suites/types.ts";

export interface CaseResult {
  caseId: string;
  suite: SuiteName;
  answer: { text: string; bubbles?: string[]; actions: { kind: string; detail?: string }[] };
  checks: CheckResult[];
  judge: JudgeScore | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GateFailure {
  caseId: string;
  check: string;
  detail?: string;
}

export interface SuiteScore {
  suite: string;
  version: number;
  cases: number;
  hardCheckPassRate: number;
  checkPassRate: number;
  judgeMean: number;
  gateFailed: boolean;
  gateFailures: GateFailure[];
  p50Ms: number;
  p95Ms: number;
  inputTokens: number;
  outputTokens: number;
  usdPer1kAnswers: number;
}

export interface PathInfo {
  live: boolean;
  name: string;
  detail: string;
}

export interface CaseFingerprint {
  suite: string;
  version: number;
  hardPass: boolean;
  judgeMean: number | null;
}

export interface GateEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  gitSha: string | null;
  broken: boolean;
  suites: Record<string, SuiteScore>;
  caseCount: number;
  gateFailed: boolean;
  paths: Record<string, PathInfo>;
  judge: { id: string; live: boolean };
  dns: string;
  calibration: { agreement: number; kept: boolean; provisional: boolean };
  holdout: { configured: boolean; reason?: string; pinMatch?: boolean };
  prices: { inputPer1k: number; outputPer1k: number; configured: boolean };
  // Per-case scores for matched baselines. The holdout never appears here;
  // only its suite aggregates are public.
  fingerprints: Record<string, CaseFingerprint>;
  eligibility: GateEligibility;
}

export interface RunOptions {
  suites?: string[];
  broken?: boolean;
  judge?: JudgeClient | null;
  dns?: DnsClient;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  onlyCaseIds?: Set<string>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function pricesFromEnv(env: NodeJS.ProcessEnv): RunReport["prices"] {
  const input = Number(env.QUALITY_PRICE_INPUT_PER_1K ?? "");
  const output = Number(env.QUALITY_PRICE_OUTPUT_PER_1K ?? "");
  const configured = Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0);
  return { inputPer1k: configured ? input : 0, outputPer1k: configured ? output : 0, configured };
}

export function scoreSuite(suite: SuiteBuild, results: CaseResult[], prices: RunReport["prices"]): SuiteScore {
  const allChecks = results.flatMap((r) => r.checks);
  const casesPassing = results.filter((r) => r.checks.every((c) => c.pass)).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const inputTokens = results.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = results.reduce((s, r) => s + r.outputTokens, 0);
  const gate: GateFailure[] = [];
  for (const r of results) {
    for (const f of gateFailures(r.checks)) gate.push({ caseId: r.caseId, check: f.id, detail: f.detail });
  }
  const judges = results.map((r) => r.judge).filter((j): j is JudgeScore => j !== null);
  const usd = (inputTokens / 1000) * prices.inputPer1k + (outputTokens / 1000) * prices.outputPer1k;
  return {
    suite: suite.suite,
    version: suite.version,
    cases: results.length,
    hardCheckPassRate: results.length === 0 ? 1 : casesPassing / results.length,
    checkPassRate: hardCheckPassRate(allChecks),
    judgeMean: judgeMean(judges),
    gateFailed: gate.length > 0,
    gateFailures: gate,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    inputTokens,
    outputTokens,
    usdPer1kAnswers: results.length === 0 ? 0 : (usd / results.length) * 1000,
  };
}

function judgeForSuite(judge: JudgeClient | null | undefined, env: NodeJS.ProcessEnv): JudgeClient {
  if (judge !== undefined) {
    if (judge === null) return new FakeJudge();
    return judge;
  }
  const model = judgeClientFromEnv(env);
  return model.live ? new MetaJudge(model) : new FakeJudge();
}

export interface BenchOutcome {
  report: Partial<RunReport> & Pick<RunReport, "suites">;
  results: CaseResult[];
  paths: Record<string, PathInfo>;
  judge: JudgeClient;
  skippedSuites: string[];
  expectedCaseIds: string[];
}

export async function runBench(opts: RunOptions = {}): Promise<BenchOutcome> {
  const env = opts.env ?? process.env;
  assertJudgeServingDiffer(env);
  const dns = opts.dns ?? dnsFromEnv(env);
  const judge = judgeForSuite(opts.judge, env);
  const broken = opts.broken ?? env.MANO_QUALITY_BROKEN === "1";
  const wanted = new Set(opts.suites ?? ["chat", "text", "letters", "safety"]);

  const builds: SuiteBuild[] = [];
  for (const suite of buildAllSuites()) {
    if (wanted.has(suite.suite)) builds.push(suite);
  }
  const holdout = loadHoldout(env.MANO_QUALITY_HOLDOUT_PATH, env.MANO_QUALITY_HOLDOUT_SHA256);
  const holdoutWanted = wanted.has("safety-holdout");
  if (holdoutWanted && holdout.configured && holdout.cases) {
    builds.push(buildHoldoutSuite(holdout.cases, holdout.version ?? 1));
  }
  const built = new Set(builds.map((b) => b.suite));
  const skippedSuites = [...wanted].filter((s) => !built.has(s as SuiteBuild["suite"]));

  const loaded = await loadAllAnswerPaths(broken);
  const paths: Record<string, PathInfo> = {};
  for (const [suite, info] of Object.entries(loaded)) {
    paths[suite] = { live: info.path.live, name: info.path.name, detail: info.detail };
  }
  if (builds.some((b) => b.suite === ("safety-holdout" as SuiteName))) {
    paths["safety-holdout"] = paths.safety!;
  }

  const results: CaseResult[] = [];
  const judgeItems: { result: CaseResult; item: { answer: string; facts: string; reference: string } }[] = [];

  for (const build of builds) {
    const suiteKey = (build.suite === ("safety-holdout" as SuiteName) ? "safety" : build.suite) as SuiteName;
    for (const c of build.cases) {
      if (opts.onlyCaseIds && !opts.onlyCaseIds.has(c.id)) continue;
      const start = Date.now();
      let answer: BenchAnswer;
      try {
        answer = await loaded[suiteKey]!.path.answer(c);
      } catch (err) {
        answer = { text: "", actions: [], latencyMs: Date.now() - start, inputTokens: 0, outputTokens: 0 };
        results.push({
          caseId: c.id, suite: c.suite,
          answer: { text: "", actions: [{ kind: "answer-error", detail: err instanceof Error ? err.message : "unknown" }] },
          checks: [{ id: "answer-error", pass: false, detail: "the answer path threw" }],
          judge: null, latencyMs: Date.now() - start, inputTokens: 0, outputTokens: 0,
        });
        continue;
      }
      const checks = await runHardChecks(c, answer, dns);
      const result: CaseResult = {
        caseId: c.id, suite: build.suite as SuiteName,
        answer: { text: answer.text, ...(answer.bubbles ? { bubbles: answer.bubbles } : {}), actions: answer.actions },
        checks, judge: null,
        latencyMs: answer.latencyMs || Date.now() - start,
        inputTokens: answer.inputTokens, outputTokens: answer.outputTokens,
      };
      results.push(result);
      judgeItems.push({ result, item: { answer: answer.text, facts: calibrationFacts(c), reference: c.reference } });
    }
  }

  const scores = await judgeAll(judgeItems.map((j) => j.item), judge);
  scores.forEach((s, i) => {
    judgeItems[i]!.result.judge = s;
  });

  const prices = pricesFromEnv(env);
  const suites: Record<string, SuiteScore> = {};
  for (const build of builds) {
    suites[build.suite] = scoreSuite(build, results.filter((r) => r.suite === (build.suite as SuiteName)), prices);
  }

  // Calibration runs on every bench so a drifting judge cannot pass silently.
  const cal = buildCalibrationSet();
  const calScores = await judgeAll(cal.map((c) => ({ answer: c.answer, facts: c.facts, reference: c.reference })), judge, 99);
  const calAgreement = agreement(calScores, cal.map((c) => c.label));

  void JUDGE_AGREEMENT_MIN;
  const expectedCaseIds = opts.onlyCaseIds
    ? [...opts.onlyCaseIds]
    : builds.flatMap((b) => b.cases.map((c) => c.id));
  return {
    report: {
      suites,
      calibration: { agreement: calAgreement, kept: calAgreement >= JUDGE_AGREEMENT_MIN, provisional: CALIBRATION_LABELS_PROVISIONAL },
      holdout: holdout.configured
        ? { configured: true, pinMatch: holdout.pinMatch }
        : { configured: false, reason: holdout.reason },
    },
    results,
    paths,
    judge,
    skippedSuites,
    expectedCaseIds,
  };
}

export interface FinishInput {
  results: CaseResult[];
  expectedCaseIds: string[];
  requireHoldout: boolean;
}

// A run is gate-eligible only when every case ran against production code
// with the live judge, coverage matches the expected case list exactly, the
// judge is calibrated on hand labels, and (for full runs) the holdout verified.
export function finishReport(
  partial: Partial<RunReport> & Pick<RunReport, "suites">,
  ctx: { runId: string; startedAt: string; finishedAt: string; gitSha: string | null; broken: boolean; paths: Record<string, PathInfo>; judge: JudgeClient; dns: string; env: NodeJS.ProcessEnv },
  input: FinishInput,
): RunReport {
  const caseCount = Object.values(partial.suites).reduce((s, suite) => s + suite.cases, 0);
  const calibration = partial.calibration ?? { agreement: 0, kept: false, provisional: true };
  const holdout = partial.holdout ?? { configured: false };
  const fingerprints: Record<string, CaseFingerprint> = {};
  for (const r of input.results) {
    if (r.suite === "safety-holdout") continue;
    const version = partial.suites[r.suite]?.version ?? 0;
    fingerprints[r.caseId] = {
      suite: r.suite,
      version,
      hardPass: r.checks.every((c) => c.pass),
      judgeMean: r.judge ? (r.judge.helpful + r.judge.accurate + r.judge.plain + r.judge.warm) / 4 : null,
    };
  }
  const ran = new Set(input.results.map((r) => r.caseId));
  const missing = input.expectedCaseIds.filter((id) => !ran.has(id));
  const expected = new Set(input.expectedCaseIds);
  const extra = input.results.map((r) => r.caseId).filter((id) => !expected.has(id));
  const reasons: string[] = [];
  for (const [suite, info] of Object.entries(ctx.paths)) {
    if (suite in partial.suites && !info.live) reasons.push(`suite ${suite} ran on a stand-in path`);
  }
  if (!ctx.judge.live) reasons.push("judge is a stand-in");
  if (calibration.provisional) reasons.push("calibration labels are provisional");
  else if (!calibration.kept) reasons.push(`judge agreement ${Math.round(calibration.agreement * 100)}% is under 80%`);
  if (missing.length > 0) reasons.push(`missing cases: ${missing.join(", ")}`);
  if (extra.length > 0) reasons.push(`unexpected cases: ${extra.join(", ")}`);
  if (input.requireHoldout && !holdout.configured) reasons.push(`holdout not verified (${holdout.reason ?? "unconfigured"})`);
  return {
    runId: ctx.runId,
    startedAt: ctx.startedAt,
    finishedAt: ctx.finishedAt,
    gitSha: ctx.gitSha,
    broken: ctx.broken,
    suites: partial.suites,
    caseCount,
    gateFailed: Object.values(partial.suites).some((s) => s.gateFailed),
    paths: ctx.paths,
    judge: { id: ctx.judge.id, live: ctx.judge.live },
    dns: ctx.dns,
    calibration,
    holdout,
    prices: pricesFromEnv(ctx.env),
    fingerprints,
    eligibility: { eligible: reasons.length === 0, reasons },
  };
}
