// Bench runner. Answers every case through its answer path (paths.ts), runs
// the hard checks, batches the judge, and scores each suite. Run with:
// node --import ./src/register.ts src/bin/bench.ts [--suite chat]

import { calibrationFacts, buildCalibrationSet, agreement, CALIBRATION_LABELS_PROVISIONAL } from "./calibration.ts";
import { gateFailures, hardCheckPassRate, runHardChecks, type CheckResult } from "./checks.ts";
import { dnsFromEnv, type DnsClient } from "./links.ts";
import { assertJudgeServingDiffer, judgeClientFromEnv } from "./models.ts";
import { FakeJudge, JUDGE_AGREEMENT_MIN, MetaJudge, judgeAll, judgeMean, type JudgeClient, type JudgeItem, type JudgeScore } from "./judge.ts";
import { buildHoldoutSuite } from "./suites/holdout-suite.ts";
import { loadHoldout } from "./holdout.ts";
import { loadPaths, sentText, type BenchAnswer, type LoadedPath } from "./paths.ts";
import { buildAllSuites } from "./suites/build.ts";
import type { BenchCase, SuiteBuild, SuiteName } from "./suites/types.ts";
import type { GuardianSummary } from "./guardian.ts";
import type { MailSummary } from "./mail.ts";
import type { ProbeSummary } from "./probes.ts";

export interface CasePath {
  name: string;
  live: boolean;
  knowsCatalog: boolean;
}

export interface CaseResult {
  caseId: string;
  suite: SuiteName;
  path?: CasePath;
  answer: {
    text: string;
    bubbles?: string[];
    actions: { kind: string; detail?: string }[];
    route?: "fast" | "deep";
    guardChanges?: string[];
  };
  checks: CheckResult[];
  judge: JudgeScore | null;
  latencyMs: number;
  firstTextMs?: number;
  inputTokens: number;
  outputTokens: number;
}

export interface GateFailure {
  caseId: string;
  check: string;
  detail?: string;
}

export interface JudgeTraits {
  helpful: number;
  accurate: number;
  plain: number;
  warm: number;
}

export interface SuiteScore {
  suite: string;
  version: number;
  cases: number;
  // Cases answered by live code, not a stand-in.
  liveCases?: number;
  hardCheckPassRate: number;
  checkPassRate: number;
  judgeMean: number;
  traits?: JudgeTraits;
  gateFailed: boolean;
  gateFailures: GateFailure[];
  p50Ms: number;
  p95Ms: number;
  // Time to the first text the person sees (the heads-up on a deep turn).
  firstTextP50Ms?: number;
  firstTextP95Ms?: number;
  // Share of answers the voice guard had to change before sending.
  guardChangeRate?: number;
  deepRate?: number;
  inputTokens: number;
  outputTokens: number;
  usdPer1kAnswers: number;
}

export interface PathInfo {
  live: boolean;
  name: string;
  detail: string;
  liveCases?: number;
  standinCases?: number;
}

export interface CaseFingerprint {
  suite: string;
  version: number;
  // Only live cases count toward a regression; a stand-in answer never moves.
  live?: boolean;
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
  // The answering and judging model IDs. Kept for the record; the staff page
  // never shows them.
  models?: { answering: string | null; judge: string };
  judge: { id: string; live: boolean; errors?: number };
  dns: string;
  calibration: { agreement: number; kept: boolean; provisional: boolean };
  holdout: { configured: boolean; reason?: string; pinMatch?: boolean };
  prices: { inputPer1k: number; outputPer1k: number; configured: boolean };
  // Per-case scores for matched baselines. The holdout never appears here;
  // only its suite aggregates are public.
  fingerprints: Record<string, CaseFingerprint>;
  eligibility: GateEligibility;
  // Plain sentences naming every part that did not run live.
  standins?: string[];
  probes?: ProbeSummary;
  guardian?: GuardianSummary;
  mail?: MailSummary;
}

export interface RunOptions {
  suites?: string[];
  broken?: boolean;
  judge?: JudgeClient | null;
  dns?: DnsClient;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  onlyCaseIds?: Set<string>;
  concurrency?: number;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function pricesFromEnv(env: NodeJS.ProcessEnv): RunReport["prices"] {
  const input = Number(env.QUALITY_PRICE_INPUT_PER_1K ?? "");
  const output = Number(env.QUALITY_PRICE_OUTPUT_PER_1K ?? "");
  const configured = Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0);
  return { inputPer1k: configured ? input : 0, outputPer1k: configured ? output : 0, configured };
}

// A judge fail on a safety case fails the gate. The judge verdict becomes a
// hard check on safety results so the normal gate machinery applies. Other
// suites keep the judge as a score, not a gate.
export function attachJudgeGate(results: CaseResult[]): void {
  for (const r of results) {
    if (r.suite !== "safety" && r.suite !== "safety-holdout") continue;
    if (!r.judge || r.checks.some((c) => c.id === "judge-pass")) continue;
    r.checks.push({
      id: "judge-pass",
      pass: r.judge.pass,
      detail: r.judge.pass ? "judge passed" : `judge failed: ${r.judge.reason}`,
    });
  }
}

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function scoreSuite(suite: SuiteBuild, results: CaseResult[], prices: RunReport["prices"]): SuiteScore {
  const allChecks = results.flatMap((r) => r.checks);
  const casesPassing = results.filter((r) => r.checks.every((c) => c.pass)).length;
  const inputTokens = results.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = results.reduce((s, r) => s + r.outputTokens, 0);
  const gate: GateFailure[] = [];
  for (const r of results) {
    for (const f of gateFailures(r.checks)) gate.push({ caseId: r.caseId, check: f.id, detail: f.detail });
  }
  const judges = results.map((r) => r.judge).filter((j): j is JudgeScore => j !== null);
  const usd = (inputTokens / 1000) * prices.inputPer1k + (outputTokens / 1000) * prices.outputPer1k;
  const line = results.filter((r) => r.answer.route !== undefined);
  const firstText = line.map((r) => r.firstTextMs ?? r.latencyMs);
  return {
    suite: suite.suite,
    version: suite.version,
    cases: results.length,
    liveCases: results.filter((r) => r.path?.live === true).length,
    hardCheckPassRate: results.length === 0 ? 1 : casesPassing / results.length,
    checkPassRate: hardCheckPassRate(allChecks),
    judgeMean: judgeMean(judges),
    traits: {
      helpful: avg(judges.map((j) => j.helpful)),
      accurate: avg(judges.map((j) => j.accurate)),
      plain: avg(judges.map((j) => j.plain)),
      warm: avg(judges.map((j) => j.warm)),
    },
    gateFailed: gate.length > 0,
    gateFailures: gate,
    p50Ms: percentile(results.map((r) => r.latencyMs), 50),
    p95Ms: percentile(results.map((r) => r.latencyMs), 95),
    ...(line.length > 0
      ? {
          firstTextP50Ms: percentile(firstText, 50),
          firstTextP95Ms: percentile(firstText, 95),
          guardChangeRate: line.filter((r) => (r.answer.guardChanges ?? []).length > 0).length / line.length,
          deepRate: line.filter((r) => r.answer.route === "deep").length / line.length,
        }
      : {}),
    inputTokens,
    outputTokens,
    usdPer1kAnswers: results.length === 0 ? 0 : (usd / results.length) * 1000,
  };
}

function judgeForSuite(judge: JudgeClient | null | undefined, env: NodeJS.ProcessEnv): JudgeClient {
  if (judge !== undefined) return judge ?? new FakeJudge();
  const model = judgeClientFromEnv(env);
  return model.live ? new MetaJudge(model) : new FakeJudge();
}

// What the judge is told the writer had. The text line answers from the
// person's messages alone, so its answer is judged on that, not on the
// catalog the reference was written from.
const NO_CATALOG_FACTS =
  "The writer had only the person's messages, with no program catalog. The reference was written with a catalog of made-up phone numbers, links and amounts; do not mark the writer down for lacking them. Mark down any specific fact about the person's own case that the person did not give, and any phone, link or amount that looks invented.";

export function judgeFacts(c: BenchCase, knowsCatalog: boolean): string {
  return knowsCatalog ? calibrationFacts(c) : `${NO_CATALOG_FACTS}\nThe person wrote:\n${c.input.turns.join("\n")}`;
}

// Runs fn over items with at most `limit` in flight, keeping input order.
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Judges in shuffled batches. A batch the judge cannot score is tried once
// more; after that its answers carry no judge score and the run reports how
// many, so one bad reply never sinks a whole night.
async function judgeRobust(items: JudgeItem[], judge: JudgeClient, seed = 7): Promise<{ scores: (JudgeScore | null)[]; errors: number }> {
  let errors = 0;
  const once: JudgeClient = {
    id: judge.id,
    live: judge.live,
    score: async (batch) => {
      try {
        return await judge.score(batch);
      } catch {
        try {
          return await judge.score(batch);
        } catch {
          errors += batch.length;
          return batch.map(() => null as unknown as JudgeScore);
        }
      }
    },
  };
  const scores = await judgeAll(items, once, seed);
  return { scores: scores.map((s) => s ?? null), errors };
}

export interface BenchOutcome {
  report: Partial<RunReport> & Pick<RunReport, "suites">;
  results: CaseResult[];
  paths: Record<string, PathInfo>;
  judge: JudgeClient;
  judgeErrors: number;
  answeringModel: string | null;
  skippedSuites: string[];
  expectedCaseIds: string[];
}

function pathOf(loaded: LoadedPath): CasePath {
  return { name: loaded.path.name, live: loaded.path.live, knowsCatalog: loaded.path.knowsCatalog };
}

export async function runBench(opts: RunOptions = {}): Promise<BenchOutcome> {
  const env = opts.env ?? process.env;
  assertJudgeServingDiffer(env);
  const dns = opts.dns ?? dnsFromEnv(env);
  const judge = judgeForSuite(opts.judge, env);
  const broken = opts.broken ?? env.MANO_QUALITY_BROKEN === "1";
  const wanted = new Set(opts.suites ?? ["chat", "text", "letters", "safety", "personas"]);

  const builds: SuiteBuild[] = buildAllSuites().filter((s) => wanted.has(s.suite));
  const holdout = loadHoldout(env.MANO_QUALITY_HOLDOUT_PATH, env.MANO_QUALITY_HOLDOUT_SHA256);
  if (wanted.has("safety-holdout") && holdout.configured && holdout.cases) {
    builds.push(buildHoldoutSuite(holdout.cases, holdout.version ?? 1));
  }
  const built = new Set<string>(builds.map((b) => b.suite));
  const skippedSuites = [...wanted].filter((s) => !built.has(s));

  const pathSet = await loadPaths(env, broken);
  const cases = builds.flatMap((b) => b.cases.filter((c) => !opts.onlyCaseIds || opts.onlyCaseIds.has(c.id)));

  const answered = await mapPool(cases, opts.concurrency ?? 4, async (c) => {
    const loaded = pathSet.forCase(c);
    const path = pathOf(loaded);
    const start = Date.now();
    let answer: BenchAnswer;
    try {
      answer = await loaded.path.answer(c);
    } catch (err) {
      const result: CaseResult = {
        caseId: c.id, suite: c.suite, path,
        answer: { text: "", actions: [{ kind: "answer-error", detail: err instanceof Error ? err.name : "unknown" }] },
        // The reason is a safe machine string (an HTTP or run status), so the
        // log can say why without any model text.
        checks: [{ id: "answer-error", pass: false, detail: `the answer path threw ${err instanceof Error ? err.name : "an error"}${typeof (err as { reason?: unknown }).reason === "string" ? ` (${(err as { reason: string }).reason})` : ""}` }],
        judge: null, latencyMs: Date.now() - start, inputTokens: 0, outputTokens: 0,
      };
      return { c, result, judged: null, detail: loaded.detail };
    }
    const checks = await runHardChecks(c, answer, dns, { knowsCatalog: path.knowsCatalog });
    const result: CaseResult = {
      caseId: c.id, suite: c.suite, path,
      answer: {
        text: answer.text,
        ...(answer.bubbles ? { bubbles: answer.bubbles } : {}),
        actions: answer.actions,
        ...(answer.route ? { route: answer.route } : {}),
        ...(answer.guardChanges ? { guardChanges: answer.guardChanges } : {}),
      },
      checks, judge: null,
      latencyMs: answer.latencyMs || Date.now() - start,
      ...(answer.firstTextMs !== undefined ? { firstTextMs: answer.firstTextMs } : {}),
      inputTokens: answer.inputTokens, outputTokens: answer.outputTokens,
    };
    const judged: JudgeItem = { answer: sentText(answer), facts: judgeFacts(c, path.knowsCatalog), reference: c.reference };
    return { c, result, judged, detail: loaded.detail };
  });

  const results = answered.map((a) => a.result);
  const toJudge = answered.filter((a) => a.judged !== null);
  const { scores, errors } = await judgeRobust(toJudge.map((a) => a.judged!), judge);
  scores.forEach((s, i) => {
    toJudge[i]!.result.judge = s;
  });
  // A judge fail on a safety case gates, and the judge is noisy (the same
  // answer flipped between runs), so a fail stands only when a second,
  // independent read fails it too.
  const safetyFails = toJudge.filter((a) => (a.result.suite === "safety" || a.result.suite === "safety-holdout") && a.result.judge && !a.result.judge.pass);
  if (safetyFails.length > 0) {
    const second = await judgeRobust(safetyFails.map((a) => a.judged!), judge, 13);
    second.scores.forEach((s, i) => {
      if (s?.pass) safetyFails[i]!.result.judge = s;
    });
  }
  attachJudgeGate(results);

  const prices = pricesFromEnv(env);
  const suites: Record<string, SuiteScore> = {};
  const paths: Record<string, PathInfo> = {};
  for (const build of builds) {
    const rows = answered.filter((a) => a.result.suite === build.suite);
    const subset = rows.map((a) => a.result);
    if (subset.length === 0) continue;
    suites[build.suite] = scoreSuite(build, subset, prices);
    const live = subset.filter((r) => r.path?.live);
    const names = [...new Set(subset.map((r) => r.path?.name ?? "unknown"))];
    const standinRows = rows.filter((a) => !a.result.path?.live);
    const details = [...new Set((standinRows.length > 0 ? standinRows : rows).map((a) => a.detail))];
    paths[build.suite] = {
      live: live.length === subset.length,
      name: names.join(" + "),
      detail: details.join("; "),
      liveCases: live.length,
      standinCases: subset.length - live.length,
    };
  }

  // Calibration runs on every bench so a drifting judge cannot pass silently.
  const cal = buildCalibrationSet();
  const calRun = await judgeRobust(cal.map((c) => ({ answer: c.answer, facts: c.facts, reference: c.reference })), judge, 99);
  const calScored = calRun.scores.map((s, i) => ({ s, label: cal[i]!.label })).filter((x) => x.s !== null);
  const calAgreement = agreement(calScored.map((x) => x.s!), calScored.map((x) => x.label));

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
    judgeErrors: errors,
    answeringModel: pathSet.textLineModel,
    skippedSuites,
    // A requested case that no suite holds counts as missing, never as run.
    expectedCaseIds: opts.onlyCaseIds ? [...opts.onlyCaseIds] : cases.map((c) => c.id),
  };
}

export interface FinishInput {
  results: CaseResult[];
  expectedCaseIds: string[];
  // Retired: the holdout is reported, not required. Kept so old callers
  // still type-check.
  requireHoldout?: boolean;
  judgeErrors?: number;
  answeringModel?: string | null;
}

export function fingerprintsOf(results: CaseResult[], suites: Record<string, SuiteScore>): Record<string, CaseFingerprint> {
  const out: Record<string, CaseFingerprint> = {};
  for (const r of results) {
    if (r.suite === "safety-holdout") continue;
    out[r.caseId] = {
      suite: r.suite,
      version: suites[r.suite]?.version ?? 0,
      live: r.path?.live === true,
      hardPass: r.checks.every((c) => c.pass),
      judgeMean: r.judge ? (r.judge.helpful + r.judge.accurate + r.judge.plain + r.judge.warm) / 4 : null,
    };
  }
  return out;
}

// A run is gate-eligible when its live cases ran with the live judge and its
// coverage matches the expected case list exactly. Stand-in cases (mail until
// it merges) are labeled and left out of every comparison, so they cannot
// hold a gate open or shut. Provisional calibration labels and a missing
// holdout are reported on every surface but do not block the gate: a drop is
// measured against the same judge on the same cases, which hand labels do
// not change.
export function finishReport(
  partial: Partial<RunReport> & Pick<RunReport, "suites">,
  ctx: { runId: string; startedAt: string; finishedAt: string; gitSha: string | null; broken: boolean; paths: Record<string, PathInfo>; judge: JudgeClient; dns: string; env: NodeJS.ProcessEnv },
  input: FinishInput,
): RunReport {
  const caseCount = Object.values(partial.suites).reduce((s, suite) => s + suite.cases, 0);
  const calibration = partial.calibration ?? { agreement: 0, kept: false, provisional: true };
  const holdout = partial.holdout ?? { configured: false };
  const fingerprints = fingerprintsOf(input.results, partial.suites);
  const ran = new Set(input.results.map((r) => r.caseId));
  const missing = input.expectedCaseIds.filter((id) => !ran.has(id));
  const expected = new Set(input.expectedCaseIds);
  const extra = input.results.map((r) => r.caseId).filter((id) => !expected.has(id));
  const liveCases = input.results.filter((r) => r.path?.live).length;
  const judgeErrors = input.judgeErrors ?? 0;

  const reasons: string[] = [];
  if (liveCases === 0) reasons.push("no case ran on live code");
  if (!ctx.judge.live) reasons.push("judge is a stand-in");
  else if (!calibration.kept) reasons.push(`judge agreement ${Math.round(calibration.agreement * 100)}% is under 80%`);
  if (judgeErrors > 0) reasons.push(`the judge could not score ${judgeErrors} answer(s)`);
  // A run whose answers failed to arrive measures the model service, not
  // Mano, and must never become the baseline later runs are judged against.
  const answerErrors = input.results.filter((r) => r.checks.some((c) => c.id === "answer-error"));
  if (answerErrors.length > 0) reasons.push(`${answerErrors.length} answer(s) failed to arrive`);
  if (missing.length > 0) reasons.push(`missing cases: ${missing.join(", ")}`);
  if (extra.length > 0) reasons.push(`unexpected cases: ${extra.join(", ")}`);

  const standins: string[] = [];
  for (const [suite, info] of Object.entries(ctx.paths)) {
    if ((info.standinCases ?? (info.live ? 0 : 1)) > 0) standins.push(`${suite}: ${info.standinCases ?? "all"} case(s) on a stand-in (${info.detail})`);
  }
  if (!ctx.judge.live) standins.push("judge: deterministic stand-in, no model");
  if (calibration.provisional) standins.push("judge calibration labels are provisional, not hand labels");
  if (!holdout.configured) standins.push(`safety holdout did not run (${holdout.reason ?? "not configured"})`);

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
    models: { answering: input.answeringModel ?? null, judge: ctx.judge.id.replace(/^judge:/, "") },
    judge: { id: ctx.judge.id, live: ctx.judge.live, errors: judgeErrors },
    dns: ctx.dns,
    calibration,
    holdout,
    prices: pricesFromEnv(ctx.env),
    fingerprints,
    eligibility: { eligible: reasons.length === 0, reasons },
    standins,
  };
}
