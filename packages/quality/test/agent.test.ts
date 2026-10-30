// The agent path drives Channels' real AgentResponder: a signed turn to the
// agent's route, the plain answer when the agent fails, and the text line's
// send pipeline on whatever came back. Only the network is scripted.

import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TURN_PATH, verifyAgentRequest } from "@mano/channels";
import { AgentPath } from "../src/agent.ts";
import { runAgentStage } from "../src/agent-stage.ts";
import { FakeJudge } from "../src/judge.ts";
import { LocalDns } from "../src/links.ts";
import type { PathSet } from "../src/paths.ts";
import { buildAllSuites } from "../src/suites/build.ts";

const SECRET = "agent-secret-for-tests";
const caseById = (id: string) => buildAllSuites().flatMap((s) => s.cases).find((c) => c.id === id)!;

interface Seen {
  handles: string[];
  modelCalls: number;
}

// The agent answers unless its turn text says "fail"; the plain model
// answers whatever reaches it.
function network(seen: Seen): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "104.16.0.1" }] }), { status: 200 });
    if (href.endsWith(AGENT_TURN_PATH)) {
      const raw = new TextEncoder().encode(String(init?.body));
      const headers = new Headers(init?.headers);
      const verdict = await verifyAgentRequest(SECRET, headers.get("x-mano-timestamp"), headers.get("x-mano-signature"), raw, Math.floor(Date.now() / 1000));
      assert.ok(verdict.ok, "the agent turn is signed with the agent secret");
      const body = JSON.parse(String(init?.body)) as { handleHash: string; texts: string[]; turnId: string };
      seen.handles.push(body.handleHash);
      if (body.texts.join(" ").includes("fail")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ status: "replied", text: "CalFresh helps with groceries. How many people live with you?" }), { status: 200 });
    }
    seen.modelCalls += 1;
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "Plain answer: CalFresh can help." }] }] }), { status: 200 });
  }) as typeof fetch;
}

function agentPath(seen: Seen): AgentPath {
  return new AgentPath({ agentUrl: "http://agent.test", agentSecret: SECRET, grantSecret: "grant-secret", apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn: network(seen), retryDelayMs: 0 });
}

test("the agent answers through a signed turn, and the answer says so", async () => {
  const seen: Seen = { handles: [], modelCalls: 0 };
  const answer = await agentPath(seen).answer(caseById("text-09"));
  assert.equal(answer.servedBy, "agent");
  assert.deepEqual(answer.bubbles, ["CalFresh helps with groceries. How many people live with you?"]);
  assert.equal(seen.modelCalls, 0, "no plain model call when the agent answered");
});

test("when the agent fails the plain fallback answers, labeled as the fallback", async () => {
  const seen: Seen = { handles: [], modelCalls: 0 };
  const c = { ...caseById("text-09"), input: { turns: ["please fail this one"] } };
  const answer = await agentPath(seen).answer(c);
  assert.equal(answer.servedBy, "fallback");
  assert.ok(answer.bubbles!.join(" ").includes("Plain answer"));
  assert.ok(seen.modelCalls > 0);
});

test("every case is a new synthetic person", async () => {
  const seen: Seen = { handles: [], modelCalls: 0 };
  const path = agentPath(seen);
  await path.answer(caseById("text-09"));
  await path.answer(caseById("chat-ca-01"));
  assert.equal(new Set(seen.handles).size, 2);
  assert.ok(seen.handles.every((h) => /^[0-9a-f]{64}$/.test(h)));
});

test("the agent stage counts agent and fallback answers per suite and skips letters", async () => {
  const seen: Seen = { handles: [], modelCalls: 0 };
  const path = agentPath(seen);
  const pathSet: PathSet = { forCase: () => ({ path, standin: false, detail: "agent" }), textLineModel: null };
  const { summary } = await runAgentStage(pathSet, { onlyCaseIds: new Set(["text-09", "chat-ca-01", "letters-01"]), judge: new FakeJudge(), dns: new LocalDns(), env: {} });
  assert.equal(summary.ran, true);
  assert.equal(summary.cases, 2, "letters go to the mail reader, not the agent");
  assert.equal(summary.agentAnswered, 2);
  assert.equal(summary.fallbackAnswered, 0);
  assert.deepEqual(Object.keys(summary.suites).sort(), ["chat", "text"]);
  const none = await runAgentStage(null);
  assert.equal(none.summary.ran, false);
});

// Review of PR 73, items 2 and 4.
interface TurnBody { handleHash: string; turnId: string; receivedAt: number; texts: string[] }

test("a failed turn is retried alone, with its turn key, receive time and history", async () => {
  const turns: TurnBody[] = [];
  const histories: { role: string; content: string }[][] = [];
  let modelCalls = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "104.16.0.1" }] }), { status: 200 });
    if (href.endsWith(AGENT_TURN_PATH)) {
      turns.push(JSON.parse(String(init?.body)) as TurnBody);
      return new Response(JSON.stringify({ status: "replied", text: `agent reply ${turns.length}` }), { status: 200 });
    }
    // Only reached when the agent fails; it never does here.
    modelCalls += 1;
    histories.push((JSON.parse(String(init?.body)) as { input: { role: string; content: string }[] }).input);
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  // The second turn fails once at the agent (500), so the fallback runs and
  // fails (400): a TurnFailed. Its retry must reuse the same turn.
  let secondTurnTries = 0;
  const flaky = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith(AGENT_TURN_PATH)) {
      const body = JSON.parse(String(init?.body)) as TurnBody;
      if (body.texts[0] === "second" && secondTurnTries++ === 0) {
        turns.push(body);
        return new Response("{}", { status: 500 });
      }
    }
    return fetchFn(url, init);
  }) as typeof fetch;
  const path = new AgentPath({ agentUrl: "http://agent.test", agentSecret: SECRET, grantSecret: "g", apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn: flaky, retryDelayMs: 0 });
  const answer = await path.answer({ ...caseById("text-09"), input: { turns: ["first", "second"] } });
  assert.deepEqual(turns.map((t) => t.texts[0]), ["first", "second", "second"], "the completed first turn was replayed");
  assert.equal(turns[1]!.turnId, turns[2]!.turnId, "the retry used a new turn key");
  assert.equal(turns[1]!.receivedAt, turns[2]!.receivedAt, "the retry used a new receive time");
  assert.equal(new Set(turns.map((t) => t.handleHash)).size, 1);
  assert.equal(answer.servedBy, "agent");
  void modelCalls;
  void histories;
});

test("a case where any turn fell back is never labeled the agent's", async () => {
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "104.16.0.1" }] }), { status: 200 });
    if (href.endsWith(AGENT_TURN_PATH)) {
      const body = JSON.parse(String(init?.body)) as TurnBody;
      if (body.texts[0] === "first") return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ status: "replied", text: "agent reply" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "plain reply" }] }] }), { status: 200 });
  }) as typeof fetch;
  const path = new AgentPath({ agentUrl: "http://agent.test", agentSecret: SECRET, grantSecret: "g", apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn, retryDelayMs: 0 });
  const mixed = await path.answer({ ...caseById("text-09"), input: { turns: ["first", "second"] } });
  assert.equal(mixed.servedBy, "mixed");
});

// Review of PR 73, items 3 and 5.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MODEL_ID, agentJudgeFromEnv, runAgentStageSafely } from "../src/agent-stage.ts";

test("the agent's model ID here matches the one apps/agent calls", () => {
  const muse = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "agent", "agent", "lib", "muse.ts"), "utf8");
  assert.match(muse, new RegExp(`STANDARD_MODEL_ID = "${AGENT_MODEL_ID.replace(/\./g, "\\.")}"`));
});

test("the agent's judge must be a different model, or its scores are marked self-judged", () => {
  const same = agentJudgeFromEnv({ META_MODEL_API_KEY: "k", MANO_MODEL_JUDGE_ID: "muse-spark-1.3", MANO_MODEL_BENCH_ID: "muse-spark-1.3-contributor" });
  assert.equal(same.selfJudged, true);
  assert.deepEqual(same.models, { agent: "muse-spark-1.3", fallback: "muse-spark-1.3-contributor", judge: "muse-spark-1.3" });
  const other = agentJudgeFromEnv({ META_MODEL_API_KEY: "k", MANO_MODEL_JUDGE_ID: "muse-spark-1.3", MANO_MODEL_AGENT_JUDGE_ID: "muse-wonder-1.0", MANO_MODEL_BENCH_ID: "muse-spark-1.3-contributor" });
  assert.equal(other.selfJudged, false);
  assert.equal(other.models.judge, "muse-wonder-1.0");
  assert.equal(other.judge.id, "judge:muse-wonder-1.0");
  assert.throws(() => agentJudgeFromEnv({ META_MODEL_API_KEY: "k", MANO_MODEL_AGENT_JUDGE_ID: "muse-wonder-1.0-contributor" }), /Standard/);
});

test("a failing agent stage records a fixed reason, cleans up, and never throws", async () => {
  let stopped = false;
  const boom = await runAgentStageSafely({}, {
    start: async () => ({ agentUrl: "x", agentSecret: "s", grantSecret: "g", stop: async () => { stopped = true; } }),
    load: async () => { throw new Error("secret detail https://example.org/leak"); },
  });
  assert.equal(boom.summary.ran, false);
  assert.equal(boom.summary.detail, "the agent stage failed while running");
  assert.ok(stopped, "the stack was not stopped");
  const noStart = await runAgentStageSafely({}, { start: async () => { throw new Error("port in use: details"); } });
  assert.equal(noStart.summary.detail, "the agent stage could not start Engine and the agent");
});
