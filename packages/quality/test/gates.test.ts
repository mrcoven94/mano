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
import { compareMatched, evalGate, prComment, publicReport, readRun, writeNightlyStaging, writeRun } from "../src/report.ts";
import { finishReport, runBench, scoreSuite, type CaseResult, type RunReport } from "../src/run.ts";
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

function eligible(report: RunReport): RunReport {
  return { ...report, eligibility: { eligible: true, reasons: [] } };
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

test("full runs require a verified holdout", async () => {
  const { full } = await smokeRun(false, SMOKE_CASE_IDS, true);
  assert.equal(full.eligibility.eligible, false);
  assert.ok(full.eligibility.reasons.some((r) => r.includes("holdout not verified")));
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
  assert.equal(m.matched, 25);
  assert.equal(m.hardBefore, 1);
  assert.equal(m.hardAfter, 0);

  const gate = evalGate(current, baseline);
  assert.equal(gate.status, "fail");
  assert.ok(gate.reasons.some((r) => r.includes("25 matching cases")));

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

test("only eligible runs become latest.json; the rest are diagnostics", async () => {
  const { full, results } = await smokeRun(false);
  const dir = mkdtempSync(join(tmpdir(), "quality-staging-"));

  const diag = writeNightlyStaging(join(dir, "ineligible"), full, results);
  assert.equal(diag.eligible, false);
  assert.ok(diag.diagnosticPath && existsSync(diag.diagnosticPath));
  assert.equal(existsSync(join(dir, "ineligible", "public", "latest.json")), false);
  assert.ok(existsSync(join(diag.privateRunDir, "cases.json")), "per-case data stays private");

  const ok = writeNightlyStaging(join(dir, "eligible"), eligible(full), results);
  assert.equal(ok.eligible, true);
  const latest = JSON.parse(readFileSync(join(dir, "eligible", "public", "latest.json"), "utf8")) as RunReport;
  assert.equal(Object.keys(latest.fingerprints).length, 25);
  const history = JSON.parse(readFileSync(join(dir, "eligible", "public", "history.json"), "utf8")) as unknown[];
  assert.equal(history.length, 1);
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
