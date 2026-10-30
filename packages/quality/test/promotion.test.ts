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
import { decidePromotion, restoreBaseline, runIdFor, writeNightlyStaging, type BaselineLogEntry, type GateEvaluation } from "../src/report.ts";
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

test("a restore puts a past main run back as the baseline, keeping its agent record, and logs it", () => {
  const root = mkdtempSync(join(tmpdir(), "restore-"));
  const past = report("2026-10-30-41007734259", { agent: agent("past"), fingerprints: { "chat-ca-01": { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4 } } });
  restoreBaseline(root, past, { ref: "refs/heads/main", actor: "mrcoven94", priorLog: [] });
  const baseline = read(join(root, "public", "baseline.json")) as { runId: string; agent: AgentSummary };
  assert.equal(baseline.runId, "2026-10-30-41007734259");
  assert.equal(baseline.agent.detail, "past");
  const log = read(join(root, "public", "baseline-log.json")) as unknown as BaselineLogEntry[];
  assert.deepEqual([log.at(-1)!.action, log.at(-1)!.runId, log.at(-1)!.by], ["restored", "2026-10-30-41007734259", "mrcoven94"]);
  assert.throws(() => restoreBaseline(root, past, { ref: "refs/heads/other", actor: "x", priorLog: [] }), /main/);
});

test("every run gets its own id, so a second run the same day never overwrites the first", () => {
  assert.equal(runIdFor("2026-10-30", { GITHUB_RUN_ID: "41007734259" }), "2026-10-30-41007734259");
  assert.equal(runIdFor("2026-10-30", {}), "2026-10-30");
});
