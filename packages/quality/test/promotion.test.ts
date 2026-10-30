// What a main nightly does to the baseline is one decision
// (decidePromotion), and writeNightlyStaging does exactly that. Every test
// here reads back what the writer put on disk: the public baseline, the
// private report with its saved decision, and the exact baseline the run
// produced. A restore works only from those saved files.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSummary } from "../src/agent-types.ts";
import { decidePromotion, restoreBaseline, runIdFor, writeNightlyStaging, type BaselineLogEntry, type HistoryRow } from "../src/report.ts";
import type { CaseFingerprint, RunReport, SuiteScore } from "../src/run.ts";

const MAIN = "refs/heads/main";
const FPS: Record<string, CaseFingerprint> = { "chat-ca-01": { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4 } };

function agent(tag: string, failures: { caseId: string; check: string }[] = [], extra: Partial<AgentSummary> = {}): AgentSummary {
  const ids = ["chat-ca-01", ...failures.map((f) => f.caseId)];
  return {
    ran: true, detail: tag, cases: ids.length, agentAnswered: ids.length, fallbackAnswered: 0, mixedAnswered: 0, workerAnswered: 0, answerErrors: 0, judgeErrors: 0,
    suites: { safety: { suite: "safety", cases: ids.length, agentAnswered: ids.length, fallbackAnswered: 0, mixedAnswered: 0, hardCheckPassRate: 1, judgeMean: 4, traits: null, gateFailures: failures, p50Ms: 1, p95Ms: 1 } },
    p50Ms: 1, p95Ms: 1,
    fingerprints: Object.fromEntries(ids.map((id) => [id, { suite: "chat", version: 1, live: true, hardPass: !failures.some((f) => f.caseId === id), judgeMean: 4, servedBy: "agent" }])),
    ...extra,
  };
}

function safetySuite(failures: { caseId: string; check: string }[]): Record<string, SuiteScore> {
  return { safety: { suite: "safety", version: 1, cases: 1, liveCases: 1, hardCheckPassRate: 0, checkPassRate: 0, judgeMean: 1, gateFailed: failures.length > 0, gateFailures: failures, p50Ms: 1, p95Ms: 1, inputTokens: 0, outputTokens: 0, usdPer1kAnswers: 0 } };
}

function report(runId: string, extra: Partial<RunReport> = {}): RunReport {
  return {
    runId, startedAt: "2026-10-31T07:00:00Z", finishedAt: "", gitSha: "abc1234", broken: false, suites: {}, caseCount: 1, gateFailed: false, paths: {},
    judge: { id: "judge:x", live: true }, dns: "", calibration: { agreement: 1, kept: true, provisional: true }, holdout: { configured: false },
    prices: { inputPer1k: 0, outputPer1k: 0, configured: false }, fingerprints: FPS, eligibility: { eligible: true, reasons: [] }, ...extra,
  };
}

const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

// A nightly as nightly.ts runs it: decide, then stage.
function nightly(root: string, run: RunReport, prior: RunReport | null, accept = false) {
  const { decision, plainGate, agentGate } = decidePromotion(run, prior, { ref: MAIN, strict: true, accept });
  const staged = writeNightlyStaging(root, run, [], [], { ref: MAIN, decision, ...(prior?.agent ? { priorAgent: prior.agent } : {}), priorLog: [] });
  const saved = read<RunReport>(join(staged.privateRunDir, "report.json"));
  const effectivePath = join(staged.privateRunDir, "baseline.json");
  const effective = existsSync(effectivePath) ? read<RunReport>(effectivePath) : null;
  const baselinePath = join(root, "public", "baseline.json");
  const baseline = existsSync(baselinePath) ? read<RunReport>(baselinePath) : null;
  return { staged, saved, effective, baseline, plainGate, agentGate, decision };
}

test("a regressed run is saved with its decision and never replaces the baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  const out = nightly(root, report("2026-10-31-1", { gateFailed: true, suites: safetySuite([{ caseId: "safety-34", check: "judge-pass" }]) }), report("prior"));
  assert.equal(out.baseline, null);
  assert.equal(out.effective, null);
  assert.equal(out.saved.promotion!.plain, "keep", "the saved report does not say what it did");
  assert.ok(out.saved.promotion!.reasons.some((r) => r.includes("safety-34")));
  assert.equal(out.plainGate.status, "fail", "CI and the decision disagree");
  const latest = read<RunReport>(join(root, "public", "latest.json"));
  assert.equal(latest.promotion!.plain, "keep");
  const log = read<BaselineLogEntry[]>(join(root, "public", "baseline-log.json"));
  assert.equal(log.at(-1)!.action, "blocked");
});

test("an ineligible prior baseline keeps the baseline, as CI fails", () => {
  const root = mkdtempSync(join(tmpdir(), "promo-"));
  const out = nightly(root, report("2026-10-31-2"), report("prior", { eligibility: { eligible: false, reasons: ["the judge could not score 3 answer(s)"] } }));
  assert.equal(out.baseline, null);
  assert.equal(out.plainGate.status, "fail");
});

test("bootstrap: the first baseline is written only if eligible and free of safety failures", () => {
  const clean = nightly(mkdtempSync(join(tmpdir(), "boot-")), report("first"), null);
  assert.equal(clean.baseline!.runId, "first");
  assert.equal(clean.plainGate.status, "pass");
  const unsafe = report("first", { gateFailed: true, suites: safetySuite([{ caseId: "safety-05", check: "crisis-ok" }]) });
  const blocked = nightly(mkdtempSync(join(tmpdir(), "boot-")), unsafe, null);
  assert.equal(blocked.baseline, null);
  assert.equal(blocked.plainGate.status, "fail");
  const accepted = nightly(mkdtempSync(join(tmpdir(), "boot-")), unsafe, null, true);
  assert.equal(accepted.baseline!.runId, "first");
  assert.equal(accepted.saved.promotion!.accepted, true);
});

test("unsafe agent bootstrap: the plain baseline is written and no agent record reaches it", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-boot-"));
  const run = report("2026-10-31-3", { agent: agent("first", [{ caseId: "safety-19", check: "crisis-ok" }]) });
  const out = nightly(root, run, report("prior"));
  assert.equal(out.baseline!.runId, "2026-10-31-3");
  assert.equal(out.baseline!.agent, undefined, "an unsafe first agent record became the baseline");
  assert.equal(out.effective!.agent, undefined);
  assert.equal(out.saved.promotion!.agent, "keep");
  assert.equal(out.agentGate!.status, "fail");
});

test("an agent regression keeps the prior agent record; accept writes the new one", () => {
  // The agent answered safety-38 in the prior run too, and it passed.
  const priorAgent = agent("prior");
  priorAgent.fingerprints!["safety-38"] = { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4, servedBy: "agent" };
  const prior = report("prior", { agent: priorAgent });
  const regressed = report("2026-10-31-4", { agent: agent("tonight", [{ caseId: "safety-38", check: "judge-pass" }]) });
  const kept = nightly(mkdtempSync(join(tmpdir(), "agent-")), regressed, prior);
  assert.equal(kept.baseline!.agent!.detail, "prior");
  assert.equal(kept.saved.promotion!.agent, "keep");
  const accepted = nightly(mkdtempSync(join(tmpdir(), "agent-")), regressed, prior, true);
  assert.equal(accepted.baseline!.agent!.detail, "tonight");
  assert.equal(accepted.saved.promotion!.accepted, true);
});

test("an agent stage that failed never reaches the baseline, at promotion or at restore", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-failed-"));
  const prior = report("prior", { agent: agent("prior") });
  const failedStage = agent("the agent stage could not start Engine and the agent", [], { ran: false, cases: 0, fingerprints: {} });
  const out = nightly(root, report("2026-10-31-5", { agent: failedStage }), prior);
  assert.equal(out.baseline!.agent!.detail, "prior");
  assert.equal(out.agentGate, null, "a stage that did not run must not sink the nightly");
  // Restore that run from what it saved, onto a later baseline.
  const later = mkdtempSync(join(tmpdir(), "restore-"));
  restoreBaseline(later, { report: out.saved, effective: out.effective }, { ref: MAIN, actor: "lead", priorLog: [], current: report("now", { agent: agent("current") }), latest: report("now"), history: [{ runId: "now" } as unknown as HistoryRow] });
  const restored = read<RunReport>(join(later, "public", "baseline.json"));
  assert.equal(restored.runId, "2026-10-31-5");
  assert.equal(restored.agent!.detail, "prior", "restore did not put back the agent record that run wrote");
  assert.notEqual(restored.agent!.ran, false);
  const log = read<BaselineLogEntry[]>(join(later, "public", "baseline-log.json"));
  assert.deepEqual([log.at(-1)!.action, log.at(-1)!.agent], ["restored", "keep"]);
  const latest = read<RunReport>(join(later, "public", "latest.json"));
  assert.equal(latest.restoredFrom!.runId, "2026-10-31-5");
  assert.equal(read<{ restoredFrom?: string }[]>(join(later, "public", "history.json")).at(-1)!.restoredFrom, "2026-10-31-5");
});

test("a blocked nightly cannot be restored without accept; with accept the current agent record stays", () => {
  const root = mkdtempSync(join(tmpdir(), "blocked-"));
  const prior = report("prior", { agent: agent("prior") });
  const out = nightly(root, report("2026-10-31-6", { gateFailed: true, suites: safetySuite([{ caseId: "safety-35", check: "judge-pass" }]), agent: agent("blocked") }), prior);
  const later = mkdtempSync(join(tmpdir(), "restore-"));
  const opts = { ref: MAIN, actor: "lead", priorLog: [], current: report("now", { agent: agent("current") }), latest: null, history: [] };
  assert.throws(() => restoreBaseline(later, { report: out.saved, effective: out.effective }, opts), /accept_baseline/);
  restoreBaseline(later, { report: out.saved, effective: out.effective }, { ...opts, accept: true });
  const restored = read<RunReport>(join(later, "public", "baseline.json"));
  assert.equal(restored.runId, "2026-10-31-6");
  assert.equal(restored.agent!.detail, "current");
});

test("a run that saved no decision cannot be restored, and off-main refs never can", () => {
  const later = mkdtempSync(join(tmpdir(), "restore-"));
  const opts = { ref: MAIN, actor: "x", priorLog: [], current: null, latest: null, history: [] };
  assert.throws(() => restoreBaseline(later, { report: report("old"), effective: null }, opts), /no promotion decision/);
  const out = nightly(mkdtempSync(join(tmpdir(), "promo-")), report("2026-10-31-7"), report("prior"));
  assert.throws(() => restoreBaseline(later, { report: out.saved, effective: out.effective }, { ...opts, ref: "refs/heads/other" }), /main/);
});

test("a branch or tag named main never promotes", () => {
  const { decision } = decidePromotion(report("t"), report("prior"), { ref: "refs/tags/main", strict: true, accept: true });
  assert.equal(decision.plain, "keep");
});

test("every run gets its own id, so a second run the same day never overwrites the first", () => {
  assert.equal(runIdFor("2026-10-30", { GITHUB_RUN_ID: "41007734259" }), "2026-10-30-41007734259");
  assert.equal(runIdFor("2026-10-30", {}), "2026-10-30");
});

// Sol's third review at 779aec1: accept_baseline overrides a regression,
// never ineligibility, on a nightly or a restore.
test("an ineligible run is never restorable, even with accept_baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "inel-"));
  const ineligible = report("2026-10-31-8", { eligibility: { eligible: false, reasons: ["the judge could not score 8 answer(s)"] } });
  const out = nightly(root, ineligible, report("prior"), true);
  assert.equal(out.baseline, null, "accept_baseline promoted an ineligible run");
  assert.equal(out.saved.promotion!.plain, "keep");
  assert.equal(out.saved.eligibility.eligible, false);
  const later = mkdtempSync(join(tmpdir(), "restore-"));
  const opts = { ref: MAIN, actor: "lead", priorLog: [], current: report("now", { agent: agent("current") }), latest: null, history: [], accept: true };
  assert.throws(() => restoreBaseline(later, { report: out.saved, effective: out.effective }, opts), /not gate-eligible/);
  assert.equal(existsSync(join(later, "public", "baseline.json")), false);
});
