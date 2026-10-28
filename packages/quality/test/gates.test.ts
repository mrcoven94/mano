// Gates: the reference path passes smoke, the breaking path fails it, and a
// rescore re-grades with no model calls.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalDns } from "../src/links.ts";
import { FakeJudge } from "../src/judge.ts";
import { rescoreRun } from "../src/rescore.ts";
import { evalGate, readRun, writeRun } from "../src/report.ts";
import { finishReport, runBench } from "../src/run.ts";
import { SMOKE_CASE_IDS } from "../src/smoke.ts";

const base = {
  dns: new LocalDns(),
  judge: new FakeJudge(),
  env: { ...process.env, MANO_QUALITY_BROKEN: "" },
};

async function smokeRun(broken: boolean) {
  const startedAt = new Date().toISOString();
  const { report, results, paths, judge } = await runBench({ broken, onlyCaseIds: new Set(SMOKE_CASE_IDS), ...base });
  const full = finishReport(report, {
    runId: broken ? "smoke-broken" : "smoke-ref",
    startedAt, finishedAt: new Date().toISOString(), gitSha: null, broken,
    paths, judge, dns: "local", env: base.env,
  });
  return { full, results };
}

test("smoke passes on the reference path", async () => {
  const { full } = await smokeRun(false);
  assert.equal(full.gateFailed, false);
  const gate = evalGate(full, null);
  assert.equal(gate.pass, true);
  assert.equal(gate.baseline, false);
  assert.equal(full.calibration.kept, true);
});

test("smoke reports 25 cases across 4 suites", async () => {
  const { full } = await smokeRun(false);
  const names = Object.keys(full.suites).sort();
  assert.deepEqual(names, ["chat", "letters", "safety", "text"]);
  const total = Object.values(full.suites).reduce((s, suite) => s + suite.cases, 0);
  assert.equal(total, 25);
});

test("smoke fails on the breaking path, then passes after the revert", async () => {
  const bad = await smokeRun(true);
  assert.equal(bad.full.gateFailed, true);
  const gateBad = evalGate(bad.full, null);
  assert.equal(gateBad.pass, false);
  assert.ok(gateBad.reasons.some((r) => r.includes("safety gate")));

  const good = await smokeRun(false);
  assert.equal(good.full.gateFailed, false);
  assert.equal(evalGate(good.full, null).pass, true);

  const gateVsBaseline = evalGate(bad.full, good.full);
  assert.equal(gateVsBaseline.pass, false);
  assert.ok(gateVsBaseline.reasons.length >= 2, "baseline comparison adds drop reasons");
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
  assert.equal(out.caseCount, full.caseCount);
});
