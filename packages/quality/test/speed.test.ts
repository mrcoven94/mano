// The speed benchmark on a fake agent: turns are signed the way the real route
// checks them, each round is one new made-up person, and a turn the agent did
// not answer counts as an error instead of a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_SIGNATURE_HEADER, AGENT_TIMESTAMP_HEADER, verifyAgentRequest } from "@mano/channels";
import { healthStats, runSpeed, turnStats, type TurnSample } from "../src/speed.ts";

const SECRET = "test-agent-secret";

interface Turn {
  handleHash: string;
  turnId: string;
  texts: string[];
  verified: boolean;
}

function fakeAgent(reply: (turn: Turn) => Response) {
  const turns: Turn[] = [];
  const healthCalls: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes("/channels/mano/turn")) {
      healthCalls.push(String(url));
      return new Response("{}", { status: String(url).includes("down") ? 503 : 200 });
    }
    const raw = String(init!.body);
    const headers = new Headers(init!.headers);
    const check = await verifyAgentRequest(SECRET, headers.get(AGENT_TIMESTAMP_HEADER), headers.get(AGENT_SIGNATURE_HEADER), new TextEncoder().encode(raw), Math.floor(Date.now() / 1000));
    const body = JSON.parse(raw) as Omit<Turn, "verified">;
    const turn = { ...body, verified: check.ok };
    turns.push(turn);
    return reply(turn);
  }) as unknown as typeof fetch;
  return { fetchFn, turns, healthCalls };
}

const options = (fetchFn: typeof fetch, rounds: number) => ({
  agentUrl: "https://agent.test",
  agentSecret: SECRET,
  grantSecret: "test-grant-secret",
  rounds,
  gapMs: 0,
  healthUrls: ["https://up.test/health", "https://down.test/health"],
  healthEveryMs: 60_000,
  fetchFn,
  sleep: async () => {},
});

test("each round signs a greeting, a SNAP question and a YES from one new person", async () => {
  const agent = fakeAgent(() => Response.json({ status: "replied", text: "Hello from the fake agent." }));
  const { turns } = await runSpeed(options(agent.fetchFn, 2));
  assert.deepEqual(turns.map((t) => t.kind), ["greeting", "snap", "yes", "greeting", "snap", "yes"]);
  assert.ok(agent.turns.every((t) => t.verified), "every turn carries a valid signature");
  assert.equal(new Set(agent.turns.map((t) => t.turnId)).size, 6);
  const people = new Set(agent.turns.map((t) => t.handleHash));
  assert.equal(people.size, 2);
  assert.ok([...people].every((h) => /^[0-9a-f]{64}$/.test(h)), "a handle hash is random, never a phone number");
  assert.equal(agent.turns[2]!.texts[0], "YES");
});

test("a failed or empty turn is an error and adds no time", async () => {
  let n = 0;
  const agent = fakeAgent(() => {
    n += 1;
    if (n === 1) return new Response("no", { status: 500 });
    if (n === 2) return Response.json({ status: "replied", text: "   " });
    return Response.json({ status: "replied", text: "ok" });
  });
  const { turns } = await runSpeed(options(agent.fetchFn, 1));
  assert.deepEqual(turns.map((t) => t.answered), [false, false, true]);
  assert.equal(turnStats(turns, "greeting").errors, 1);
  assert.equal(turnStats(turns, "greeting").medianMs, 0);
  assert.equal(turnStats(turns, "yes").errors, 0);
});

test("health is checked at the start and the end of a run and counts what failed", async () => {
  const agent = fakeAgent(() => Response.json({ status: "replied", text: "ok" }));
  const { health } = await runSpeed(options(agent.fetchFn, 1));
  assert.deepEqual(healthStats(health, "https://up.test/health"), { url: "https://up.test/health", checks: 2, ok: 2, medianMs: healthStats(health, "https://up.test/health").medianMs });
  assert.equal(healthStats(health, "https://down.test/health").ok, 0);
  assert.equal(healthStats(health, "https://down.test/health").checks, 2);
});

test("median and p90 are nearest rank over answered turns", () => {
  const samples: TurnSample[] = Array.from({ length: 20 }, (_, i) => ({ kind: "snap", round: i + 1, ms: (i + 1) * 100, answered: true }));
  samples.push({ kind: "snap", round: 21, ms: 99_999, answered: false });
  assert.deepEqual(turnStats(samples, "snap"), { turns: 21, errors: 1, medianMs: 1000, p90Ms: 1800, minMs: 100, maxMs: 2000 });
});
