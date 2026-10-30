// A2/A3: stand-in runs are neutral, never a pass; breaking runs fail;
// baselines compare matching cases at the same suite version; only eligible
// runs become the public latest.json.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalDns } from "../src/links.ts";
import { FakeJudge } from "../src/judge.ts";
import { rescoreRun } from "../src/rescore.ts";
import { compareMatched, evalGate, prComment, publicReport, readHistory, readRun, writeNightlyStaging, writeRun } from "../src/report.ts";
import { attachJudgeGate, finishReport, runBench, scoreSuite, type CaseResult, type RunReport } from "../src/run.ts";
import { buildSuite } from "../src/suites/build.ts";
import { SMOKE_CASE_IDS } from "../src/smoke.ts";

const base = {
  dns: new LocalDns(),
  judge: new FakeJudge(),
  env: { ...process.env, MANO_QUALITY_BROKEN: "" },
};

async function smokeRun(broken: boolean, onlyCaseIds = SMOKE_CASE_IDS, requireHoldout = false) {
  const startedAt = new Date().toISOString();
  const out = await runBench({ broken, onlyCaseIds: new Set(onlyCaseIds), ...base });
  const full = finishReport(out.report, {
    runId: broken ? "smoke-broken" : "smoke-ref",
    startedAt, finishedAt: new Date().toISOString(), gitSha: null, broken,
    paths: out.paths, judge: out.judge, dns: "local", env: base.env,
  }, { results: out.results, expectedCaseIds: out.expectedCaseIds, requireHoldout });
  return { full, results: out.results, skipped: out.skippedSuites };
}

// A reference run dressed up as a live, eligible one, for the comparison
// logic. Real runs get live fingerprints only from the text line.
function eligible(report: RunReport): RunReport {
  return {
    ...report,
    eligibility: { eligible: true, reasons: [] },
    fingerprints: Object.fromEntries(Object.entries(report.fingerprints).map(([id, f]) => [id, { ...f, live: true }])),
  };
}

test("reference-path smoke is neutral, never a pass", async () => {
  const { full } = await smokeRun(false);
  assert.equal(full.gateFailed, false);
  assert.equal(full.eligibility.eligible, false);
  assert.ok(full.eligibility.reasons.some((r) => r.includes("stand-in")));
  const gate = evalGate(full, null);
  assert.equal(gate.status, "neutral");
  const comment = prComment(full, null, gate, "main's last nightly run");
  assert.ok(comment.startsWith("## Quality smoke: neutral, not a pass"));
  assert.match(comment, /provisional labels/);
  assert.match(comment, /Not gate-eligible/);
});

test("breaking path fails the gate", async () => {
  const { full } = await smokeRun(true);
  assert.equal(full.gateFailed, true);
  assert.equal(evalGate(full, null).status, "fail");
});

test("coverage mismatch makes a run ineligible", async () => {
  const { full } = await smokeRun(false, [...SMOKE_CASE_IDS, "chat-nope-99"]);
  assert.equal(full.eligibility.eligible, false);
  assert.ok(full.eligibility.reasons.some((r) => r.includes("missing cases: chat-nope-99")));
});

test("a missing holdout is labeled on the run, not hidden", async () => {
  const { full } = await smokeRun(false, SMOKE_CASE_IDS, true);
  assert.ok(full.standins!.some((r) => r.includes("safety holdout did not run")));
});

test("a judge fail gates safety cases but not chat cases", () => {
  const prices = { inputPer1k: 0, outputPer1k: 0, configured: false };
  const failed = { helpful: 1, accurate: 1, plain: 1, warm: 1, pass: false, reason: "all ones" };
  const safety: CaseResult = {
    caseId: "safety-01", suite: "safety",
    answer: { text: "Your case is approved. No need to send anything.", actions: [] },
    checks: [{ id: "language", pass: true }],
    judge: failed, latencyMs: 1, inputTokens: 1, outputTokens: 1,
  };
  attachJudgeGate([safety]);
  assert.equal(scoreSuite(buildSuite("safety"), [safety], prices).gateFailed, true);
  const chat: CaseResult = {
    caseId: "chat-ca-01", suite: "chat",
    answer: { text: "x", actions: [] },
    checks: [{ id: "language", pass: true }],
    judge: failed, latencyMs: 1, inputTokens: 1, outputTokens: 1,
  };
  attachJudgeGate([chat]);
  assert.equal(chat.checks.some((c) => c.id === "judge-pass"), false);
  assert.equal(scoreSuite(buildSuite("chat"), [chat], prices).gateFailed, false);
});

test("the bench judge grades the sent bubbles", async () => {
  const seen: string[] = [];
  const capturing = {
    id: "capturing-judge", live: false,
    score: async (batch: { answer: string }[]) => {
      for (const item of batch) seen.push(item.answer);
      return batch.map(() => ({ helpful: 5, accurate: 5, plain: 5, warm: 5, pass: true, reason: "" }));
    },
  };
  await runBench({ ...base, onlyCaseIds: new Set(["text-16"]), judge: capturing });
  const reference = buildSuite("text").cases.find((c) => c.id === "text-16")!;
  assert.ok(seen.includes(reference.referenceBubbles!.join("\n")));
});

test("answer errors fail the run", () => {
  const build = buildSuite("chat");
  const errored: CaseResult = {
    caseId: "chat-ca-01", suite: "chat",
    answer: { text: "", actions: [{ kind: "answer-error" }] },
    checks: [{ id: "answer-error", pass: false, detail: "the answer path threw" }],
    judge: null, latencyMs: 1, inputTokens: 0, outputTokens: 0,
  };
  const score = scoreSuite(build, [errored], { inputPer1k: 0, outputPer1k: 0, configured: false });
  assert.equal(score.gateFailed, true);
});

test("baselines compare matching cases at the same suite version", async () => {
  const good = await smokeRun(false);
  const baseline = eligible(good.full);
  const current: RunReport = {
    ...baseline,
    runId: "smoke-lowered",
    fingerprints: Object.fromEntries(
      Object.entries(baseline.fingerprints).map(([id, f]) => [id, { ...f, hardPass: false, judgeMean: 2.0 }]),
    ),
  };

  const m = compareMatched(baseline, current);
  assert.equal(m.matched, 28);
  assert.equal(m.hardBefore, 1);
  assert.equal(m.hardAfter, 0);

  const gate = evalGate(current, baseline);
  assert.equal(gate.status, "fail");
  assert.ok(gate.reasons.some((r) => r.includes("28 matching cases")));

  const same = evalGate(baseline, eligible(good.full));
  assert.equal(same.status, "pass");

  const drifted: RunReport = {
    ...baseline,
    fingerprints: Object.fromEntries(Object.entries(baseline.fingerprints).map(([id, f]) => [id, { ...f, version: f.version + 1 }])),
  };
  assert.equal(evalGate(current, drifted).status, "neutral");

  const noBaseline = evalGate(baseline, null);
  assert.equal(noBaseline.status, "neutral");
});

test("every nightly run is recorded; only eligible runs become the baseline", async () => {
  const { full, results } = await smokeRun(false);
  const dir = mkdtempSync(join(tmpdir(), "quality-staging-"));

  const first = writeNightlyStaging(join(dir, "n"), { ...full, runId: "2026-10-28" }, results);
  assert.equal(first.eligible, false);
  assert.ok(existsSync(join(dir, "n", "public", "latest.json")), "the page always sees the latest run");
  assert.equal(existsSync(join(dir, "n", "public", "baseline.json")), false, "an ineligible run never gates anyone");
  assert.ok(existsSync(join(first.privateRunDir, "cases.json")), "per-case data stays private");
  assert.equal(existsSync(join(dir, "n", "public", "cases.json")), false);

  const prior = readHistory(join(dir, "n", "public", "history.json"));
  const second = writeNightlyStaging(join(dir, "n"), { ...eligible(full), runId: "2026-10-29" }, results, prior);
  assert.equal(second.eligible, true);
  const baseline = JSON.parse(readFileSync(join(dir, "n", "public", "baseline.json"), "utf8")) as RunReport;
  assert.equal(baseline.runId, "2026-10-29");
  assert.equal(Object.keys(baseline.fingerprints).length, 28);

  const rerun = writeNightlyStaging(join(dir, "n"), { ...eligible(full), runId: "2026-10-29" }, results, readHistory(join(dir, "n", "public", "history.json")));
  assert.ok(rerun.eligible);
  const history = readHistory(join(dir, "n", "public", "history.json"));
  assert.deepEqual(history.map((h) => h.runId), ["2026-10-28", "2026-10-29"], "a rerun replaces its own row");
  assert.deepEqual(history.map((h) => h.eligible), [false, true]);
  const publicText = readFileSync(join(dir, "n", "public", "history.json"), "utf8") + readFileSync(join(dir, "n", "public", "latest.json"), "utf8");
  assert.ok(!publicText.includes(results[0]!.answer.text.slice(0, 40)), "public files hold no answer text");
});

test("public reports keep holdout aggregates but drop per-case detail", async () => {
  const { full } = await smokeRun(false);
  const withHoldout: RunReport = {
    ...full,
    suites: {
      ...full.suites,
      "safety-holdout": {
        suite: "safety-holdout", version: 1, cases: 20, hardCheckPassRate: 1, checkPassRate: 1,
        judgeMean: 4.5, gateFailed: false, gateFailures: [{ caseId: "holdout-01", check: "x", detail: "secret" }],
        p50Ms: 1, p95Ms: 2, inputTokens: 1, outputTokens: 1, usdPer1kAnswers: 0,
      },
    },
  };
  const pub = publicReport(withHoldout);
  assert.deepEqual(pub.suites["safety-holdout"]!.gateFailures, []);
  assert.equal(pub.suites["safety-holdout"]!.cases, 20);
  assert.ok(!Object.keys(pub.fingerprints).some((id) => id.startsWith("holdout")));
});

test("rescore re-grades a stored run with no model calls", async () => {
  const { full, results } = await smokeRun(false);
  const dir = mkdtempSync(join(tmpdir(), "quality-rescore-"));
  writeRun(join(dir, "in"), full, results);
  const out = await rescoreRun(join(dir, "in"), join(dir, "out"));
  const reread = readRun(join(dir, "out"));
  assert.equal(reread.report.runId, `${full.runId}-rescored`);
  for (const suite of Object.keys(full.suites)) {
    assert.equal(reread.report.suites[suite]!.hardCheckPassRate, full.suites[suite]!.hardCheckPassRate);
    assert.equal(reread.report.suites[suite]!.judgeMean, full.suites[suite]!.judgeMean);
  }
  assert.deepEqual(Object.keys(reread.report.fingerprints).sort(), Object.keys(full.fingerprints).sort());
  assert.equal(out.caseCount, full.caseCount);
});
