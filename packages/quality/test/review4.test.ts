// Review 4 (Sol, head 76cc0c8): each finding reproduced as a test before the
// fix. Item 6 (mail) is answered in mail.ts and stages.test.ts.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHardChecks } from "../src/checks.ts";
import type { JudgeClient } from "../src/judge.ts";
import { LocalDns } from "../src/links.ts";
import { MetaModelClient } from "../src/models.ts";
import { runProbes } from "../src/probes.ts";
import { decidePromotion, evalGate, publicReport, writeNightlyStaging } from "../src/report.ts";
import type { AgentSummary } from "../src/agent-types.ts";
import { finishReport, runBench, type CaseFingerprint, type CaseResult, type RunReport } from "../src/run.ts";
import { buildAllSuites } from "../src/suites/build.ts";
import { TextLine, TextLinePath } from "../src/textline.ts";

const caseById = (id: string) => buildAllSuites().flatMap((s) => s.cases).find((c) => c.id === id)!;

function run(fps: Record<string, CaseFingerprint>, extra: Partial<RunReport> = {}): RunReport {
  return {
    runId: "r", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:10:00Z", gitSha: null, broken: false,
    suites: {}, caseCount: Object.keys(fps).length, gateFailed: false, paths: {},
    judge: { id: "judge:x", live: true }, dns: "doh",
    calibration: { agreement: 0.9, kept: true, provisional: true }, holdout: { configured: false },
    prices: { inputPer1k: 0, outputPer1k: 0, configured: false },
    fingerprints: fps, eligibility: { eligible: true, reasons: [] }, ...extra,
  };
}
const fps = (n: number, judgeMean = 4): Record<string, CaseFingerprint> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`c-${i}`, { suite: "chat", version: 1, live: true, hardPass: true, judgeMean }]));

const liveJudge: JudgeClient = { id: "judge:x", live: true, score: async () => [] };
const ctx = { runId: "r", startedAt: "", finishedAt: "", gitSha: null, broken: false, paths: {}, judge: liveJudge, dns: "doh", env: {} };

function modelFetch(reply: (input: { role: string; content: string }[]) => string | Response, seen: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "104.16.0.1" }] }), { status: 200 });
    seen.push({ url: href, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const body = JSON.parse(String(init?.body)) as { input: { role: string; content: string }[] };
    const out = reply(body.input);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: out }] }] }), { status: 200 });
  }) as typeof fetch;
}

// 1. An unusable gate must not pass in CI.
// The decision a nightly would take for this run, against a prior that
// holds the same plain results (so only the agent record can differ).
function decideFor(rep: RunReport, ref: string, priorAgent?: AgentSummary) {
  return decidePromotion(rep, priorAgent ? { ...rep, agent: priorAgent } : null, { ref, strict: false, accept: false }).decision;
}

test("in strict mode a missing baseline, missing R2 keys or an ineligible run fails, never neutral", () => {
  assert.equal(evalGate(run(fps(5)), null).status, "neutral", "offline runs stay neutral");
  assert.equal(evalGate(run(fps(5)), null, { strict: true }).status, "fail");
  const missing = evalGate(run(fps(5)), null, { strict: true, missing: ["R2 credentials are not set"] });
  assert.equal(missing.status, "fail");
  assert.ok(missing.reasons.some((r) => r.includes("R2 credentials")));
  const ineligible = run(fps(5), { eligibility: { eligible: false, reasons: ["the judge could not score 8 answer(s)"] } });
  assert.equal(evalGate(ineligible, run(fps(5)), { strict: true }).status, "fail");
  assert.equal(evalGate(run(fps(5)), run(fps(5), { eligibility: { eligible: false, reasons: ["x"] } }), { strict: true }).status, "fail");
});

// 2. Probe execution errors.
test("a probe that failed to run fails the run and blocks eligibility", async () => {
  const fetchFn = modelFetch(() => new Response("{}", { status: 429 }));
  const probes = await runProbes(new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn }), 4, 0);
  assert.equal(probes.errors, probes.total);
  const report = finishReport({ suites: {}, calibration: { agreement: 0.9, kept: true, provisional: true } }, ctx, { results: [], expectedCaseIds: [], probes });
  assert.equal(report.eligibility.eligible, false);
  assert.ok(report.eligibility.reasons.some((r) => r.includes("probe")));
  const gate = evalGate({ ...run(fps(5)), probes, eligibility: report.eligibility }, run(fps(5)));
  assert.equal(gate.status, "fail");
  assert.ok(gate.reasons.some((r) => r.includes("did not run")));
});

// 3. Only main promotes the baseline.
test("a branch run writes under its own prefix and never touches the baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-branch-"));
  const report = run(fps(3), { runId: "2026-10-30" });
  const staged = writeNightlyStaging(root, report, [], [], { ref: "refs/heads/lap-567-quality", decision: decideFor(report, "refs/heads/lap-567-quality") });
  assert.equal(staged.promoted, false);
  assert.equal(existsSync(join(root, "public", "baseline.json")), false);
  assert.equal(existsSync(join(root, "public", "latest.json")), false, "a branch must not replace main's latest");
  assert.ok(existsSync(join(root, "public", "branches", "lap-567-quality", "latest.json")));
  assert.ok(existsSync(join(root, "private", "branches", "lap-567-quality", "runs", "2026-10-30", "cases.json")));
  const main = writeNightlyStaging(join(root, "m"), report, [], [], { ref: "refs/heads/main", decision: decideFor(report, "refs/heads/main") });
  assert.equal(main.promoted, true);
  assert.ok(existsSync(join(root, "m", "public", "baseline.json")));
});

// 4. Every sent bubble is checked.
test("a promise in a deep heads-up fails no-promise", async () => {
  const fetchFn = modelFetch((input) => (input.at(-1)!.role === "assistant" ? "Here is how renewals work." : "DEEP: You are approved, guaranteed."));
  const answer = await new TextLinePath(new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn }), 0).answer(caseById("chat-ca-01"));
  const checks = await runHardChecks(caseById("chat-ca-01"), answer, new LocalDns(), { knowsCatalog: false });
  assert.equal(checks.find((c) => c.id === "no-promise")!.pass, false);
});

test("an earlier turn's reply is checked too", async () => {
  let n = 0;
  const fetchFn = modelFetch(() => (++n === 1 ? "You qualify for sure." : "Glad to help."));
  const c = { ...caseById("text-09"), input: { turns: ["hi", "can I get food help"] } };
  const answer = await new TextLinePath(new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn }), 0).answer(c);
  const checks = await runHardChecks(c, answer, new LocalDns(), { knowsCatalog: false });
  assert.equal(checks.find((x) => x.id === "no-promise")!.pass, false);
});

// 5. AI Gateway logging is off for the responder and the judge.
test("through AI Gateway both clients send cf-aig-collect-log: false", async () => {
  const gateway = "https://gateway.ai.cloudflare.com/v1/acct/gw/meta";
  const seen: { url: string; headers: Record<string, string> }[] = [];
  await new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", baseUrl: gateway, fetchFn: modelFetch(() => "Hi.", seen) }).turn(["hi"], []);
  assert.ok(seen.length > 0 && seen.every((s) => s.headers["cf-aig-collect-log"] === "false"), JSON.stringify(seen.map((s) => s.headers)));
  const judgeSeen: Record<string, string>[] = [];
  const judgeFetch = (async (_u: string | URL, init?: RequestInit) => {
    judgeSeen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200 });
  }) as typeof fetch;
  await new MetaModelClient("muse-spark-1.3", gateway, "k", judgeFetch).complete([{ role: "user", content: "x" }]);
  assert.equal(judgeSeen[0]!["cf-aig-collect-log"], "false");
});

// 7. Calibration must score every case.
test("a calibration batch the judge cannot score blocks eligibility", async () => {
  let calls = 0;
  const judge: JudgeClient = {
    id: "judge:x", live: true,
    score: async (batch) => {
      calls += 1;
      if (batch.length === 8 && calls > 2) throw new Error("judge reply unusable (bad-json), sha256 000000000000");
      return batch.map(() => ({ helpful: 4, accurate: 4, plain: 4, warm: 4, pass: true, reason: "ok" }));
    },
  };
  const out = await runBench({ onlyCaseIds: new Set(["chat-ca-01"]), judge, dns: new LocalDns(), env: {} });
  assert.ok(out.judgeErrors > 0, "calibration errors are judge errors");
  assert.equal(out.report.calibration!.kept, false, "agreement over survivors is not calibration");
});

// 8. Public aggregates carry identifiers and counts only.
test("the public report drops judge reasons, check details and reader output", () => {
  const report = run(fps(2), {
    suites: { safety: { suite: "safety", version: 1, cases: 1, liveCases: 1, hardCheckPassRate: 0, checkPassRate: 0, judgeMean: 1, gateFailed: true, gateFailures: [{ caseId: "safety-34", check: "judge-pass", detail: 'judge failed: says "Probably not malpractice"' }, { caseId: "safety-20", check: "links-ok", detail: "https://evil.example.org/x: blocked" }], p50Ms: 1, p95Ms: 1, inputTokens: 1, outputTokens: 1, usdPer1kAnswers: 0 } },
    mail: { live: true, detail: "packages/mail", letters: 1, correct: 0, accuracy: 0, misses: [{ caseId: "letters-01", expected: "November 15, 2026", published: "SECRET READER OUTPUT" }] },
  });
  const text = JSON.stringify(publicReport(report));
  assert.ok(!text.includes("Probably not"), "a judge reason quoting the answer was published");
  assert.ok(!text.includes("evil.example.org"), "a response URL was published");
  assert.ok(!text.includes("SECRET READER OUTPUT"));
  assert.ok(text.includes("safety-34") && text.includes("judge-pass"), "identifiers stay");
});

// 6 (mail): stand-in cases never count toward a promoted baseline.
test("a promoted baseline holds live cases only", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-live-only-"));
  const fp = { ...fps(2), "letters-01": { suite: "letters", version: 1, live: false, hardPass: true, judgeMean: 5 } };
  writeNightlyStaging(root, run(fp), [], [], { ref: "refs/heads/main", decision: decideFor(run(fp), "refs/heads/main") });
  const baseline = JSON.parse(readFileSync(join(root, "public", "baseline.json"), "utf8")) as RunReport;
  assert.equal(baseline.fingerprints["letters-01"], undefined);
  assert.ok(baseline.fingerprints["c-0"]);
});

void ({} as CaseResult);

// Review 4, round 2 (Sol, 719649d).
test("a heads-up sent before a failed attempt is still checked", async () => {
  // The first try sends a promise as its heads-up, then its deep call fails
  // with a 400; the retry answers harmlessly on the fast path.
  let fastCalls = 0;
  const fetchFn = modelFetch((input) => {
    if (input.at(-1)!.role === "assistant") return new Response("{}", { status: 400 });
    fastCalls += 1;
    return fastCalls === 1 ? "DEEP: You are approved, guaranteed." : "Happy to walk you through renewals.";
  });
  const answer = await new TextLinePath(new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn }), 0).answer(caseById("chat-ca-01"));
  const checks = await runHardChecks(caseById("chat-ca-01"), answer, new LocalDns(), { knowsCatalog: false });
  assert.equal(checks.find((c) => c.id === "no-promise")!.pass, false, `sent before the retry: ${JSON.stringify(answer.earlier)}`);
});

test("only refs/heads/main promotes; a tag named main does not", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-ref-"));
  const report = run(fps(2), { runId: "2026-10-30" });
  const tag = writeNightlyStaging(join(root, "t"), report, [], [], { ref: "refs/tags/main", decision: decideFor(report, "refs/tags/main") });
  assert.equal(tag.promoted, false);
  assert.equal(existsSync(join(root, "t", "public", "baseline.json")), false);
  assert.equal(existsSync(join(root, "t", "public", "latest.json")), false);
  const bare = writeNightlyStaging(join(root, "b"), report, [], [], { ref: "main", decision: decideFor(report, "main") });
  assert.equal(bare.promoted, false, "a bare name is not a ref");
  const main = writeNightlyStaging(join(root, "m"), report, [], [], { ref: "refs/heads/main", decision: decideFor(report, "refs/heads/main") });
  assert.equal(main.promoted, true);
});
