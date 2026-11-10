// Smoke replay: the live smoke's code path on recorded model replies, so a
// pull request still proves the text line and the gate's checks when no key
// is set or the model provider is down. Only the network is replayed: the
// text line's /responses calls (replies and the crisis check) and its link
// lookups. The real SparkResponder, crisis decision, voice guard, link
// check, bubble split, crisis line, hard checks, judge gate and scoring all
// run. The replies in smoke-replay.json are synthetic, written for these
// cases. The judge is the deterministic FakeJudge and links resolve through
// LocalDns, so the result never depends on a provider.
// Run: node --import ./src/register.ts src/bin/smoke-replay.ts [--out runs/smoke-replay]

import { readFileSync } from "node:fs";
import { CRISIS_CHECK_INSTRUCTIONS } from "@mano/persona";
import { gateFailures } from "./checks.ts";
import { FakeJudge } from "./judge.ts";
import { LocalDns } from "./links.ts";
import { ReferencePath, needsMailReader, type LoadedPath, type PathSet } from "./paths.ts";
import { finishReport, runBench, type CaseResult, type RunReport } from "./run.ts";
import { buildAllSuites } from "./suites/build.ts";
import { TextLine, TextLinePath } from "./textline.ts";

export interface ReplayFixture {
  // Case ID to the recorded reply for each of its turns, in order.
  replies: Record<string, string[]>;
  // A person's text to the crisis check's recorded answer ("yes" or "no").
  crisisChecks: Record<string, string>;
}

export const REPLAY_FIXTURE_PATH = new URL("./smoke-replay.json", import.meta.url);
const RUN_ID_SEPARATORS_RE = /[-:T]/g;

export function loadReplayFixture(): ReplayFixture {
  return JSON.parse(readFileSync(REPLAY_FIXTURE_PATH, "utf8")) as ReplayFixture;
}

function completed(text: string): Response {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

interface ResponsesBody {
  instructions?: string;
  input?: { role: string; content: string }[] | string;
}

// Answers the text line's requests from the fixture. A request it holds no
// recording for throws, so a changed case or a new model call fails the
// replay instead of passing on a made-up reply.
// The text line swallows some failed calls on purpose (a failed crisis check
// counts as a crisis), so every miss is also kept in `misses` for the result.
export function replayFetch(fixture: ReplayFixture, used: Set<string>, misses: string[] = []): typeof fetch {
  const miss = (what: string): never => {
    misses.push(what);
    throw new Error(what);
  };
  const cases = new Map(buildAllSuites().flatMap((s) => s.cases).map((c) => [c.id, c]));
  const byText = new Map<string, { key: string; reply: string }>();
  for (const [caseId, replies] of Object.entries(fixture.replies)) {
    const c = cases.get(caseId);
    if (!c) throw new Error(`smoke-replay.json names unknown case ${caseId}`);
    if (replies.length !== c.input.turns.length) throw new Error(`smoke-replay.json holds ${replies.length} replies for ${caseId}, which has ${c.input.turns.length} turns`);
    c.input.turns.forEach((turn, i) => {
      if (byText.has(turn)) throw new Error(`two replayed turns share the text "${turn}"`);
      byText.set(turn, { key: `${caseId}#${i + 1}`, reply: replies[i]! });
    });
  }
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    if (href.includes("dns-query")) {
      const host = new URL(href).searchParams.get("name") ?? "";
      const answer = await new LocalDns().resolveA(host);
      return new Response(JSON.stringify({ Status: 0, Answer: answer.addresses.map((data) => ({ type: 1, data })) }), { status: 200 });
    }
    if (!href.endsWith("/responses")) miss(`replay has no recording for ${href}`);
    const body = JSON.parse(String(init?.body)) as ResponsesBody;
    const input = Array.isArray(body.input) ? body.input : [];
    if (body.instructions === CRISIS_CHECK_INSTRUCTIONS) {
      const asked = String(input[0]?.content ?? "");
      const hit = Object.entries(fixture.crisisChecks).find(([text]) => asked.includes(text));
      if (!hit) return miss(`replay has no recorded crisis check for: ${asked.slice(0, 80)}`);
      used.add(`crisis:${hit[0]}`);
      return completed(hit[1]);
    }
    const last = [...input].reverse().find((m) => m.role === "user")?.content ?? "";
    const hits = [...byText].filter(([text]) => last.includes(text));
    if (hits.length !== 1) return miss(`replay has ${hits.length === 0 ? "no" : "more than one"} recorded reply for: ${last.slice(0, 80)}`);
    used.add(hits[0]![1].key);
    return completed(hits[0]![1].reply);
  }) as typeof fetch;
}

export interface ReplayOutcome {
  status: "pass" | "fail";
  reasons: string[];
  // Checks that missed without gating, as the live gate treats them.
  notes: string[];
  report: RunReport;
  results: CaseResult[];
  // Case IDs that ran on the text line with replayed replies, and the
  // others that ran without a model call.
  replayed: string[];
  withoutModel: string[];
}

// The cases the replay covers, fixed here and not read from the fixture, so
// a recording deleted from smoke-replay.json fails the replay instead of
// quietly dropping its case.
export const REPLAYED_CASE_IDS = ["chat-ca-01", "text-16", "safety-01", "safety-05", "safety-07", "safety-19", "safety-27"];

// Cases the replay runs with no model call. A texted letter photo and the
// scam letter go to the mail reader: the live smoke reads them with
// packages/mail on a model, and the replay answers them with the reference
// stand-in. STOP is answered by the worker before any model call, in both.
export const NO_MODEL_CASE_IDS = ["text-17", "letters-16", "text-19"];

// What the fixture's recordings must cover: exactly REPLAYED_CASE_IDS.
function coverageGaps(fixture: ReplayFixture): string[] {
  const recorded = Object.keys(fixture.replies);
  return [
    ...REPLAYED_CASE_IDS.filter((id) => !recorded.includes(id)).map((id) => `${id} has no recording in smoke-replay.json`),
    ...recorded.filter((id) => !REPLAYED_CASE_IDS.includes(id)).map((id) => `smoke-replay.json records ${id}, which is not a replay case`),
  ];
}

export async function runReplay(loaded: ReplayFixture = loadReplayFixture()): Promise<ReplayOutcome> {
  const gaps = coverageGaps(loaded);
  const fixture: ReplayFixture = {
    ...loaded,
    replies: Object.fromEntries(Object.entries(loaded.replies).filter(([id]) => REPLAYED_CASE_IDS.includes(id))),
  };
  const used = new Set<string>();
  const misses: string[] = [];
  const line = new TextLine({
    apiKey: "replay",
    model: "replay-model-contributor",
    crisisCheckModel: "replay-crisis-model",
    baseUrl: "https://replay.invalid/v1",
    fetchFn: replayFetch(fixture, used, misses),
  });
  const text: LoadedPath = { path: new TextLinePath(line, 0), standin: false, detail: "the text line on recorded replies" };
  const mail: LoadedPath = { path: new ReferencePath(), standin: true, detail: "reference stand-in; the live smoke uses the mail reader" };
  const pathSet: PathSet = { forCase: (c) => (needsMailReader(c) ? mail : text), textLineModel: line.model };
  const ids = [...REPLAYED_CASE_IDS, ...NO_MODEL_CASE_IDS];
  const startedAt = new Date().toISOString();
  const judge = new FakeJudge();
  const bench = await runBench({ onlyCaseIds: new Set(ids), judge, dns: new LocalDns(), pathSet, env: {}, skipCalibration: true });
  const report = finishReport(bench.report, {
    runId: `replay-${startedAt.slice(0, 16).replace(RUN_ID_SEPARATORS_RE, "")}`,
    startedAt, finishedAt: new Date().toISOString(), gitSha: null, broken: false,
    paths: bench.paths, judge, dns: "local", env: {},
  }, { results: bench.results, expectedCaseIds: bench.expectedCaseIds, judgeErrors: bench.judgeErrors, answeringModel: line.model });

  const reasons: string[] = [...gaps, ...new Set(misses)];
  const ran = new Set(bench.results.map((r) => r.caseId));
  for (const id of ids) if (!ran.has(id)) reasons.push(`${id} did not run`);
  // Fails exactly where the live gate does. Quality misses that do not gate
  // (a look-alike that got the crisis line, by design since #67) are noted.
  const notes: string[] = [];
  for (const r of bench.results) {
    const gating = new Set(gateFailures(r.checks).map((c) => c.id));
    for (const c of r.checks.filter((x) => !x.pass)) {
      (gating.has(c.id) ? reasons : notes).push(`${r.caseId} failed ${c.id}${c.detail ? `: ${c.detail}` : ""}`);
    }
  }
  for (const [caseId, replies] of Object.entries(fixture.replies)) {
    replies.forEach((_, i) => {
      if (!used.has(`${caseId}#${i + 1}`)) reasons.push(`${caseId} turn ${i + 1}: its recorded reply was never requested`);
    });
  }
  for (const text of Object.keys(fixture.crisisChecks)) {
    if (!used.has(`crisis:${text}`)) reasons.push(`the recorded crisis check for "${text}" was never requested`);
  }
  return {
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    notes,
    report,
    results: bench.results,
    replayed: REPLAYED_CASE_IDS,
    withoutModel: NO_MODEL_CASE_IDS,
  };
}

export function replaySummary(o: ReplayOutcome): string {
  const lines = [
    `## Quality smoke replay: ${o.status}`,
    "",
    `The live smoke's code path on recorded synthetic replies, with no model key. ${o.replayed.length} case(s) ran through the text line (${o.replayed.join(", ")}); ${o.withoutModel.length} case(s) ran with no model call: the letter photo and scam letter on the reference stand-in (the live smoke reads those two with the mail reader, on a model), and STOP in the worker, as in the live smoke (${o.withoutModel.join(", ")}).`,
    "This proves the code path and the safety checks, not answer quality: the replies are fixed, the judge is the deterministic stand-in and links resolve through the local table.",
  ];
  if (o.reasons.length > 0) lines.push("", "Gate failures:", ...o.reasons.map((r) => `- ${r}`));
  if (o.notes.length > 0) lines.push("", "Quality misses that do not gate, as in the live smoke:", ...o.notes.map((r) => `- ${r}`));
  return lines.join("\n");
}
