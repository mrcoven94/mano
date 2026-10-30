// Lead decision (Oct 30, after run 41017357447): a main nightly that
// regressed against the prior baseline is recorded but not promoted, so its
// new safety failures never become "known". The agent record is kept on an
// agent regression. A deliberate accept_baseline promotes anyway, and every
// decision is logged. A restore puts a past main run's report back as the
// baseline through the same code.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSummary } from "../src/agent-types.ts";
import { decidePromotion, promotionVerdict, restoreBaseline, runIdFor, writeNightlyStaging, type BaselineLogEntry, type GateEvaluation, type HistoryRow } from "../src/report.ts";
import type { RunReport } from "../src/run.ts";

const pass: GateEvaluation = { status: "pass", reasons: [], baseline: true, matchedCases: 20, preexisting: [] };
const fail = (reasons: string[]): GateEvaluation => ({ status: "fail", reasons, baseline: true, matchedCases: 20, preexisting: [] });

function agent(tag: string): AgentSummary {
  return {
    ran: true, detail: tag, cases: 1, agentAnswered: 1, fallbackAnswered: 0, mixedAnswered: 0, workerAnswered: 0, answerErrors: 0, judgeErrors: 0,
    suites: {}, p50Ms: 1, p95Ms: 1, fingerprints: { "chat-ca-01": { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4, servedBy: "agent" } },
  };
}

function report(runId: string, extra: Partial<RunReport> = {}): RunReport {
  return {
    runId, startedAt: "2026-10-31T07:00:00Z", finishedAt: "", gitSha: "abc1234", broken: false, suites: {}, caseCount: 0, gateFailed: false, paths: {},
    judge: { id: "judge:x", live: true }, dns: "", calibration: { agreement: 1, kept: true, provisional: true }, holdout: { configured: false },
    prices: { inputPer1k: 0, outputPer1k: 0, configured: false }, fingerprints: {}, eligibility: { eligible: true, reasons: [] }, ...extra,
  };
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("a main run that regressed is recorded but not promoted, and latest says why", () => {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  const promotion = decidePromotion({ plain: fail(["new safety failures: safety-34 (judge-pass)"]), agent: null, accept: false });
  const staged = writeNightlyStaging(root, report("2026-10-31-1"), [], [], { ref: "refs/heads/main", promotion });
  assert.equal(staged.promoted, false);
  assert.equal(existsSync(join(root, "public", "baseline.json")), false, "the regressed run replaced the baseline");
  const latest = read(join(root, "public", "latest.json")) as { promotion: { promoted: boolean; reasons: string[] } };
  assert.equal(latest.promotion.promoted, false);
  assert.ok(latest.promotion.reasons.some((r) => r.includes("safety-34")));
  const log = read(join(root, "public", "baseline-log.json")) as unknown as BaselineLogEntry[];
  assert.equal(log.at(-1)!.action, "blocked");
});

test("an agent regression keeps the prior agent record while the plain line promotes", () => {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  const promotion = decidePromotion({ plain: pass, agent: fail(["agent: new safety failures: safety-19 (crisis-ok)"]), accept: false });
  writeNightlyStaging(root, report("2026-10-31-2", { agent: agent("tonight") }), [], [], { ref: "refs/heads/main", priorAgent: agent("prior"), promotion });
  const baseline = read(join(root, "public", "baseline.json")) as { runId: string; agent: AgentSummary };
  assert.equal(baseline.runId, "2026-10-31-2");
  assert.equal(baseline.agent.detail, "prior", "the regressed agent record was promoted");
  const latest = read(join(root, "public", "latest.json")) as { promotion: { promoted: boolean; agentPromoted: boolean } };
  assert.deepEqual([latest.promotion.promoted, latest.promotion.agentPromoted], [true, false]);
});

test("accept_baseline promotes a regressed run on purpose, and the log says so", () => {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  const promotion = decidePromotion({ plain: fail(["judge mean 4.10 to 3.60"]), agent: fail(["agent: hard-check pass 90.0 to 80.0"]), accept: true });
  writeNightlyStaging(root, report("2026-10-31-3", { agent: agent("tonight") }), [], [], { ref: "refs/heads/main", priorAgent: agent("prior"), promotion, actor: "mrcoven94" });
  const baseline = read(join(root, "public", "baseline.json")) as { runId: string; agent: AgentSummary };
  assert.equal(baseline.runId, "2026-10-31-3");
  assert.equal(baseline.agent.detail, "tonight");
  const log = read(join(root, "public", "baseline-log.json")) as unknown as BaselineLogEntry[];
  assert.equal(log.at(-1)!.action, "accepted");
  assert.equal(log.at(-1)!.by, "mrcoven94");
  assert.ok(log.at(-1)!.reasons.some((r) => r.includes("judge mean")));
  const history = read(join(root, "public", "history.json")) as unknown as { promotion?: { accepted: boolean } }[];
  assert.equal(history.at(-1)!.promotion!.accepted, true);
});

test("accept_baseline does nothing off main", () => {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  const promotion = decidePromotion({ plain: pass, agent: null, accept: true });
  const staged = writeNightlyStaging(root, report("r"), [], [], { ref: "refs/heads/some-branch", promotion });
  assert.equal(staged.promoted, false);
});

test("a restore puts a past main run's effective baseline back, updates latest and history, and logs it", () => {
  const root = mkdtempSync(join(tmpdir(), "restore-"));
  const past = report("2026-10-30-41007734259", { agent: agent("raw-past"), fingerprints: { "chat-ca-01": { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4 } } });
  const effective = { ...past, agent: agent("effective-past") };
  const latest = report("2026-10-31-9", { promotion: { promoted: true, agentPromoted: true, accepted: false, reasons: [] } });
  const history = [{ runId: "2026-10-31-9" }] as unknown as HistoryRow[];
  restoreBaseline(root, { report: past, effective }, { ref: "refs/heads/main", actor: "mrcoven94", priorLog: [], current: report("now", { agent: agent("current") }), latest, history });
  const baseline = read(join(root, "public", "baseline.json")) as { runId: string; agent: AgentSummary };
  assert.equal(baseline.runId, "2026-10-30-41007734259");
  assert.equal(baseline.agent.detail, "effective-past", "the raw agent record was installed instead of the effective one");
  const log = read(join(root, "public", "baseline-log.json")) as unknown as BaselineLogEntry[];
  assert.deepEqual([log.at(-1)!.action, log.at(-1)!.runId, log.at(-1)!.by], ["restored", "2026-10-30-41007734259", "mrcoven94"]);
  const newLatest = read(join(root, "public", "latest.json")) as { restoredFrom: { runId: string }; promotion: { promoted: boolean; reasons: string[] } };
  assert.equal(newLatest.restoredFrom.runId, "2026-10-30-41007734259");
  assert.equal(newLatest.promotion.promoted, false, "latest still claims to be the baseline");
  const newHistory = read(join(root, "public", "history.json")) as unknown as { runId: string; restoredFrom?: string }[];
  assert.equal(newHistory.at(-1)!.restoredFrom, "2026-10-30-41007734259");
  assert.throws(() => restoreBaseline(root, { report: past, effective }, { ref: "refs/heads/other", actor: "x", priorLog: [], current: null, latest: null, history: [] }), /main/);
});

test("without the effective baseline, a restore never installs an ineligible agent record", () => {
  const root = mkdtempSync(join(tmpdir(), "restore-"));
  const broken = { ...agent("raw-past"), ran: false, detail: "the agent stage could not start Engine and the agent" };
  const past = report("2026-10-30-1", { agent: broken });
  restoreBaseline(root, { report: past, effective: null }, { ref: "refs/heads/main", actor: "x", priorLog: [], current: report("now", { agent: agent("current") }), latest: null, history: [] });
  const baseline = read(join(root, "public", "baseline.json")) as { agent: AgentSummary };
  assert.equal(baseline.agent.detail, "current");
  const log = read(join(root, "public", "baseline-log.json")) as unknown as BaselineLogEntry[];
  assert.ok(log.at(-1)!.reasons.some((r) => r.includes("agent record kept")), JSON.stringify(log.at(-1)));
});

test("a run that was blocked from promotion cannot be restored", () => {
  const root = mkdtempSync(join(tmpdir(), "restore-"));
  const blocked = report("2026-10-30-2", { promotion: { promoted: false, agentPromoted: false, accepted: false, reasons: ["x"] } });
  assert.throws(() => restoreBaseline(root, { report: blocked, effective: null }, { ref: "refs/heads/main", actor: "x", priorLog: [], current: null, latest: null, history: [] }), /never became the baseline/);
});

// Sol on #76: one verdict for promotion and CI, and an explicit bootstrap.
test("an ineligible prior baseline does not let a run promote itself in strict mode", () => {
  const prior = report("prior", { eligibility: { eligible: false, reasons: ["the judge could not score 3 answer(s)"] } });
  const v = promotionVerdict(report("tonight"), prior, { strict: true, accept: false });
  assert.equal(v.promotion.promoted, false);
  assert.equal(v.plain.status, "fail", "CI and promotion must agree");
});

test("bootstrap: the first baseline promotes only if eligible and free of safety failures", () => {
  const clean = promotionVerdict(report("first"), null, { strict: true, accept: false });
  assert.equal(clean.promotion.promoted, true);
  assert.equal(clean.plain.status, "pass");
  const unsafe = report("first", { gateFailed: true, suites: { safety: { suite: "safety", version: 1, cases: 1, liveCases: 1, hardCheckPassRate: 0, checkPassRate: 0, judgeMean: 1, gateFailed: true, gateFailures: [{ caseId: "safety-05", check: "crisis-ok" }], p50Ms: 1, p95Ms: 1, inputTokens: 0, outputTokens: 0, usdPer1kAnswers: 0 } } });
  const blocked = promotionVerdict(unsafe, null, { strict: true, accept: false });
  assert.equal(blocked.promotion.promoted, false);
  assert.equal(blocked.plain.status, "fail");
  assert.ok(blocked.promotion.reasons.some((r) => r.includes("safety-05")));
  assert.equal(promotionVerdict(unsafe, null, { strict: true, accept: true }).promotion.promoted, true);
});

test("bootstrap: a first agent record with safety failures is not promoted", () => {
  const unsafeAgent = { ...agent("first"), suites: { safety: { suite: "safety", cases: 1, agentAnswered: 1, fallbackAnswered: 0, mixedAnswered: 0, hardCheckPassRate: 0, judgeMean: 1, traits: null, gateFailures: [{ caseId: "chat-ca-01", check: "no-promise" }], p50Ms: 1, p95Ms: 1 } } };
  // The plain line matches its baseline; only the agent record is new.
  const fingerprints = { "chat-ca-01": { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4 } };
  const prior = report("prior", { fingerprints });
  const tonight = (extra: Partial<RunReport>) => report("tonight", { fingerprints, ...extra });
  const blocked = promotionVerdict(tonight({ agent: unsafeAgent }), prior, { strict: true, accept: false });
  assert.equal(blocked.promotion.promoted, true);
  assert.equal(blocked.promotion.agentPromoted, false);
  assert.equal(blocked.agent!.status, "fail");
  const clean = promotionVerdict(tonight({ agent: agent("first") }), prior, { strict: true, accept: false });
  assert.equal(clean.promotion.agentPromoted, true);
  const none = promotionVerdict(tonight({ agent: { ...agent("x"), ran: false } }), prior, { strict: true, accept: false });
  assert.equal(none.promotion.agentPromoted, false);
  assert.equal(none.agent, null, "an agent stage that did not run gives no verdict and never sinks the nightly");
});

test("every run gets its own id, so a second run the same day never overwrites the first", () => {
  assert.equal(runIdFor("2026-10-30", { GITHUB_RUN_ID: "41007734259" }), "2026-10-30-41007734259");
  assert.equal(runIdFor("2026-10-30", {}), "2026-10-30");
});
