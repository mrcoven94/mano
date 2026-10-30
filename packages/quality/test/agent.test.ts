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
