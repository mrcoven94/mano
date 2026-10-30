// @mano/quality: the system that tells Mano whether its answers are getting
// better or worse, without ever keeping what a person wrote.
//
// The bench (synthetic, every PR and every night): versioned suites in
// suites/ answered by the real text line (textline.ts: SparkResponder with
// Mano's persona and the worker's send pipeline) on Meta models, and by the
// mail reader for letters and photos (a labeled stand-in until packages/mail
// merges). Hard checks (checks.ts) are code only; the judge (judge.ts) grades
// 1 to 5 on helpful, accurate, plain, warm. The nightly run (bin/nightly.ts)
// adds the persona probes (probes.ts), Guardian against production
// (guardian.ts) and mail's deadline accuracy (mail.ts), and records the run
// with its history in R2 (sync.ts). Pull requests run the 28-case smoke
// subset plus the probes and gate against the last eligible nightly run
// (bin/smoke.ts, publish.ts). rescore.ts re-grades stored runs with no model
// calls.
//
// Live quality (scores and counts, never text): the engine and channels call
// LiveQuality.afterAnswer after each answer (invented facts and unsafe links
// block before sending), classifyConversation once per conversation, and
// recordFeedback on votes. alerts.ts posts numbers-only threshold crossings
// to LAP-567. The staff page reads run JSON and suppressed counters.
//
// How to run: pnpm --filter @mano/quality bench | smoke | nightly | calibrate.
// Keys come from the environment: META_MODEL_API_KEY with MANO_MODEL_BENCH_ID
// (the answering model; a -contributor ID is fine for synthetic cases) and
// MANO_MODEL_JUDGE_ID (a Standard ID); MANO_GUARDIAN_* for Guardian; R2_* to
// read and write runs. Without them every part falls back to a stand-in and
// the report names it. Scripts run TypeScript through src/register.ts.
// How to test: pnpm --filter @mano/quality check (no keys needed).

export { alertBody, evalAlert, linearPosterFromEnv, postToLinearTicket } from "./alerts.ts";
export type { AlertEvaluation, DayQuality, LinearPoster } from "./alerts.ts";
export { buildCalibrationSet, agreement, CALIBRATION_LABELS_PROVISIONAL, calibrationFacts } from "./calibration.ts";
export { CRISIS_SIGNAL_RES, needsCrisisResponse } from "./crisis.ts";
export type { CalibrationCase } from "./calibration.ts";
export { GATE_CHECK_IDS, containsPromise, extractAmounts, extractDates, extractIdNumbers, extractPhones, extractUrls, findInventedFacts, gateFailures, hardCheckPassRate, normalizeNumericDate, normalizeWordAmount, runHardChecks } from "./checks.ts";
export type { CheckResult } from "./checks.ts";
export { CRISIS_LINE, FIXTURE_STATES, RESIDENT_NAMES, SCAM_HOSTS, SCAM_PHONES, factsForState, stateByCode } from "./facts.ts";
export type { FixtureProgram, FixtureState } from "./facts.ts";
export { HOLDOUT_CASE_COUNT, HOLDOUT_SHA256_PIN, HOLDOUT_VERSION, loadHoldout } from "./holdout.ts";
export type { HoldoutLoad } from "./holdout.ts";
export { FakeJudge, JUDGE_AGREEMENT_MIN, JUDGE_BATCH_SIZE, JUDGE_RUBRIC, MetaJudge, judgeAll, judgeMean, judgePrompt, parseJudgeScores, scoreByOverlap } from "./judge.ts";
export type { JudgeClient, JudgeItem, JudgeScore } from "./judge.ts";
export { DohDns, LocalDns, checkLink, dnsFromEnv } from "./links.ts";
export type { DnsAnswer, DnsClient, DnsMode, LinkVerdict } from "./links.ts";
export { JUDGE_SAMPLE_RATE, LIVE_BLOCKING_CHECKS, LiveQuality, displayTotal, expectedJudgeId, gradingPayload, inboundNeedsCrisis, maskText, sampleForJudge, suppressCounts } from "./live.ts";
export type { LiveAnswerInput, LiveAnswerResult, LiveHooksDeps, SuppressedCounts } from "./live.ts";
export { MemoryLiveStore } from "./live-store.ts";
export type { AnswerOutcome, CounterKey, FeedbackRow, JudgeSample, LiveStore } from "./live-store.ts";
export { DEFAULT_JUDGE_MODEL_ID, DEFAULT_MODEL_BASE_URL, FakeModelClient, MetaModelClient, assertJudgeServingDiffer, judgeClientFromEnv, roughTokens } from "./models.ts";
export type { ChatMessage, ChatResult, ModelClient } from "./models.ts";
export { BrokenPath, ReferencePath, loadPaths, needsMailReader, sentText } from "./paths.ts";
export type { AnswerPath, BenchAction, BenchAnswer, LoadedPath, PathSet } from "./paths.ts";
export { TextLine, TextLinePath, TurnFailed, converse, textLineFromEnv } from "./textline.ts";
export type { TurnRun } from "./textline.ts";
export { runProbes } from "./probes.ts";
export type { ProbeFailure, ProbeSummary } from "./probes.ts";
export { runGuardian, scoreVerdicts } from "./guardian.ts";
export type { GuardianSummary } from "./guardian.ts";
export { TranscriptDeadlineReader, expectedDeadline, loadDeadlineReader, scoreMailDeadlines } from "./mail.ts";
export type { DeadlineReader, MailSummary } from "./mail.ts";
export { CHECK_NAME, COMMENT_MARKER, exitCodeFor, publishSmoke, readOutcome } from "./publish.ts";
export type { PublishTarget, SmokeOutcome } from "./publish.ts";
export { readPublic, uploadStaging } from "./sync.ts";
export { mulberry32, pick, sha256Hex, shuffle, stableStringify } from "./prng.ts";
export { HARD_DROP_MAX, JUDGE_DROP_MAX, compareMatched, compareSuites, evalGate, historyRow, prComment, printSideBySide, probeSafetyFailures, publicReport, readHistory, readRun, safetySummary, writeNightlyStaging, writeRun } from "./report.ts";
export type { GateEvaluation, GateStatus, HistoryRow, HistorySuite, MatchedComparison, NightlyStaging, SuiteComparison } from "./report.ts";
export { rescoreRun } from "./rescore.ts";
export { attachJudgeGate, fingerprintsOf, finishReport, judgeFacts, mapPool, percentile, runBench, scoreSuite } from "./run.ts";
export type { BenchOutcome, CaseFingerprint, CasePath, CaseResult, FinishInput, GateEligibility, GateFailure, JudgeTraits, PathInfo, RunOptions, RunReport, SuiteScore } from "./run.ts";
export { SMOKE_CASE_COUNT, SMOKE_CASE_IDS } from "./smoke.ts";
export { EMPTY_SHA256, PRIVATE_BUCKET, PUBLIC_BUCKET, privateObjectUrl, r2CredsFromEnv, r2GetJson, r2Put, signS3, signS3Get, signedPrivateGet } from "./r2.ts";
export type { R2Creds, SignedGet } from "./r2.ts";
export { scrubStaffCase, stripModelNames } from "./redact.ts";
export type { StaffCase } from "./redact.ts";
export { buildAllSuites, buildSuite, SUITE_NAMES, SUITE_VERSIONS } from "./suites/build.ts";
export { syntheticLetter, syntheticPhoto } from "./suites/art.ts";
export { CHAT_SUITE_VERSION, buildChatCases } from "./suites/chat.ts";
export { LETTERS_SUITE_VERSION, buildLettersCases } from "./suites/letters.ts";
export { PERSONAS_SUITE_VERSION, buildPersonasCases } from "./suites/personas.ts";
export { SAFETY_SUITE_VERSION, buildSafetyCases } from "./suites/safety.ts";
export { TEXT_MAX_BUBBLE_CHARS, TEXT_MAX_BUBBLES, TEXT_SUITE_VERSION, buildTextCases } from "./suites/text.ts";
export { EMPTY_FACTS } from "./suites/types.ts";
export type { BenchCase, BenchInput, CaseExpect, CaseFacts, LetterImage, Locale, SuiteBuild, SuiteName } from "./suites/types.ts";
