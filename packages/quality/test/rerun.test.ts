// Lead decision (Oct 30): before the gate decides, each case that newly
// fails a hard check or drops a judge point against the baseline is run once
// more and counts only if it fails again. Both attempts stay in the private
// results, and the PR comment says how many were rerun and how many held.

import assert from "node:assert/strict";
import test from "node:test";
import { FakeJudge } from "../src/judge.ts";
import { LocalDns } from "../src/links.ts";
import type { AnswerPath, PathSet } from "../src/paths.ts";
import { evalGate, prComment } from "../src/report.ts";
import { finishReport, rerunNewlyFailing, runBench, type CaseFingerprint, type RunReport } from "../src/run.ts";
import type { BenchCase } from "../src/suites/types.ts";

const PROMISE = " You are approved, guaranteed.";

// A live path whose answer to each case is scripted per attempt: "bad" adds
// a promise (fails no-promise), "good" is the reference.
function scripted(plan: Record<string, ("bad" | "good")[]>): PathSet {
  const seen: Record<string, number> = {};
  const path: AnswerPath = {
    name: "scripted", live: true, knowsCatalog: true,
    answer: async (c: BenchCase) => {
      const n = seen[c.id] ?? 0;
      seen[c.id] = n + 1;
      const step = plan[c.id]?.[n] ?? "good";
      return { text: step === "bad" ? `${c.reference}${PROMISE}` : c.reference, actions: [], latencyMs: 1, inputTokens: 1, outputTokens: 1 };
    },
  };
  return { forCase: () => ({ path, standin: false, detail: "scripted" }), textLineModel: null };
}

const IDS = ["chat-ca-01", "chat-tx-02", "chat-ny-03"];
const base = { dns: new LocalDns(), judge: new FakeJudge(), env: {} as NodeJS.ProcessEnv, onlyCaseIds: new Set(IDS) };
const ctx = { runId: "smoke", startedAt: "", finishedAt: "", gitSha: null, broken: false, judge: { id: "judge:x", live: true, score: async () => [] }, dns: "local", env: {} };

function baseline(): RunReport {
  const fingerprints: Record<string, CaseFingerprint> = Object.fromEntries(IDS.map((id) => [id, { suite: "chat", version: 1, live: true, hardPass: true, judgeMean: 4.5 }]));
  return {
    runId: "base", startedAt: "", finishedAt: "", gitSha: null, broken: false, suites: {}, caseCount: 3, gateFailed: false, paths: {},
    judge: { id: "judge:x", live: true }, dns: "local", calibration: { agreement: 1, kept: true, provisional: true },
    holdout: { configured: false }, prices: { inputPer1k: 0, outputPer1k: 0, configured: false }, fingerprints,
    eligibility: { eligible: true, reasons: [] },
  };
}

test("a case that fails then passes is not counted; one that fails twice is", async () => {
  const pathSet = scripted({ "chat-ca-01": ["bad", "good"], "chat-tx-02": ["bad", "bad"] });
  const first = await runBench({ ...base, pathSet });
  const { bench, rerun } = await rerunNewlyFailing(first, baseline(), { ...base, pathSet });
  assert.deepEqual(rerun.rerun.sort(), ["chat-ca-01", "chat-tx-02"]);
  assert.deepEqual(rerun.held, ["chat-tx-02"]);
  assert.deepEqual(rerun.cleared, ["chat-ca-01"]);

  const cleared = bench.results.find((r) => r.caseId === "chat-ca-01")!;
  assert.ok(cleared.checks.every((c) => c.pass), "the passing rerun is the result");
  assert.ok(cleared.otherAttempt && cleared.otherAttempt.checks.some((c) => c.id === "no-promise" && !c.pass), "the failed first try is kept");
  const held = bench.results.find((r) => r.caseId === "chat-tx-02")!;
  assert.ok(held.checks.some((c) => c.id === "no-promise" && !c.pass));
  assert.ok(held.otherAttempt, "both attempts are kept");

  const report = finishReport(bench.report, { ...ctx, paths: bench.paths }, { results: bench.results, expectedCaseIds: bench.expectedCaseIds, rerun });
  const gate = evalGate(report, baseline());
  assert.equal(gate.status, "fail");
  assert.ok(gate.reasons.some((r) => r.includes("chat-tx-02")));
  assert.ok(!gate.reasons.some((r) => r.includes("chat-ca-01")));
  assert.match(prComment(report, baseline(), gate, "main"), /Reran 2 newly failing case\(s\): 1 held, 1 passed on rerun \(chat-ca-01\)\./);
});

test("with every flake cleared the gate passes", async () => {
  const pathSet = scripted({ "chat-ca-01": ["bad", "good"] });
  const first = await runBench({ ...base, pathSet });
  const { bench, rerun } = await rerunNewlyFailing(first, baseline(), { ...base, pathSet });
  const report = finishReport(bench.report, { ...ctx, paths: bench.paths }, { results: bench.results, expectedCaseIds: bench.expectedCaseIds, rerun });
  assert.equal(evalGate(report, baseline()).status, "pass");
  assert.deepEqual(rerun.held, []);
});
