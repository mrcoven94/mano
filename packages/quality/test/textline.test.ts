// The text line path drives the real SparkResponder and the send pipeline.
// Only the network is scripted: model replies over /responses and resolver
// answers over DoH, so the voice guard, the link check, the bubble cap and
// the crisis hold all run for real.

import assert from "node:assert/strict";
import test from "node:test";
import { CRISIS_LINE, PROBES } from "@mano/persona";
import { runProbes } from "../src/probes.ts";
import { TextLine, TextLinePath, converse } from "../src/textline.ts";
import { buildAllSuites } from "../src/suites/build.ts";

interface Script {
  replies: string[];
  blockedHosts?: string[];
  seen: { instructions: string; input: { role: string; content: string }[] }[];
}

function fakeFetch(script: Script): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("dns-query")) {
      const host = new URL(href).searchParams.get("name") ?? "";
      const blocked = (script.blockedHosts ?? []).includes(host);
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: blocked ? "0.0.0.0" : "104.16.0.1" }] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Script["seen"][number];
    script.seen.push(body);
    const text = script.replies.shift() ?? "ok";
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text }] }] }), { status: 200 });
  }) as typeof fetch;
}

function line(script: Script): TextLine {
  return new TextLine({ apiKey: "test-key", model: "muse-spark-1.3-contributor", fetchFn: fakeFetch(script) });
}

const caseById = (id: string) => buildAllSuites().flatMap((s) => s.cases).find((c) => c.id === id)!;

test("a fast reply goes through the voice guard and the link check before it counts", async () => {
  const script: Script = { replies: ["**Yes**, SNAP helps — apply at https://evil.example.org/x or https://benefits.example.gov/apply."], blockedHosts: ["evil.example.org"], seen: [] };
  const run = await line(script).turn(["can i get food help"], []);
  assert.equal(run.route, "fast");
  const sent = run.bubbles.join(" ");
  assert.ok(!sent.includes("**"), "markdown reached the person");
  assert.ok(!sent.includes("—"), "a dash reached the person");
  assert.ok(!sent.includes("evil.example.org"), "a blocked link reached the person");
  assert.ok(sent.includes("benefits.example.gov"), "a clean link was removed");
  assert.equal(run.linksRemoved, 1);
  assert.ok(run.guardChanges.includes("markdown") && run.guardChanges.includes("dash"), run.guardChanges.join(","));
  assert.ok(script.seen[0]!.instructions.includes("PACING"), "the fast call carries the router");
});

test("a deep turn sends its heads-up first and times the first text from it", async () => {
  const script: Script = { replies: ["DEEP: Let me check how Ohio counts that, one minute.", "With $2,100 a month and 2 kids you are likely under the limit."], seen: [] };
  const run = await line(script).turn(["I make $2,100 a month with 2 kids in Ohio, do I qualify for SNAP?"], []);
  assert.equal(run.route, "deep");
  assert.equal(run.headsUp, "Let me check how Ohio counts that, one minute.");
  assert.ok(run.firstTextMs <= run.totalMs);
  assert.equal(script.seen.length >= 2, true);
  assert.equal(script.seen.at(-1)!.input.at(-1)!.content, run.headsUp, "the deep call sees the heads-up as Mano's last message");
});

test("a crisis turn always carries 988 and 911, even when the model forgets", async () => {
  const script: Script = { replies: ["I'm sorry you're feeling this way. Can you tell me more?"], seen: [] };
  const run = await line(script).turn(["I want to kill myself"], []);
  assert.ok(run.bubbles.join(" ").startsWith(CRISIS_LINE), run.bubbles.join(" "));
  assert.ok(!script.seen[0]!.instructions.includes("PACING"), "a crisis must not wait on the router");
});

test("a reply that names the model is rewritten before it is scored", async () => {
  const script: Script = { replies: ["I'm muse-spark-1.3, a model by Meta. How can I help?"], seen: [] };
  const run = await line(script).turn(["what model are you"], []);
  assert.ok(!/muse|spark|meta/i.test(run.bubbles.join(" ")), run.bubbles.join(" "));
  assert.ok(run.guardChanges.length > 0);
});

test("conversations replay real replies as history", async () => {
  const script: Script = { replies: ["Hi, I'm Mano.", "Sure, what state are you in?"], seen: [] };
  const runs = await converse(line(script), ["hi", "can you help with rent"]);
  assert.equal(runs.length, 2);
  const second = script.seen.at(-1)!.input;
  assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(second[1]!.content, "Hi, I'm Mano.");
});

test("the bench path answers a case and reports route, timing and cost inputs", async () => {
  const script: Script = { replies: ["CalFresh helps with groceries in California. How many people live with you?"], seen: [] };
  const answer = await new TextLinePath(line(script)).answer(caseById("text-09"));
  assert.equal(answer.route, "fast");
  assert.deepEqual(answer.bubbles, ["CalFresh helps with groceries in California. How many people live with you?"]);
  assert.ok(answer.inputTokens > 0 && answer.outputTokens > 0);
  assert.ok(answer.firstTextMs !== undefined);
});

test("one failed model call is retried; two make an answer error", async () => {
  let calls = 0;
  const flaky = (async (url: string | URL) => {
    if (String(url).includes("dns-query")) return new Response("{}", { status: 200 });
    calls += 1;
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  const path = new TextLinePath(new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn: flaky }), 0);
  await assert.rejects(() => path.answer(caseById("text-09")), /text line failed: http_400/);
  assert.equal(calls, 2, "a 400 is fatal for the responder, so each try is one request");
});

test("probes run persona's own checks through the text line", async () => {
  const script: Script = { replies: [], seen: [] };
  const replyFor = (text: string): string => {
    if (/bot|human|real person/i.test(text)) return "I'm Mano, an automated assistant, not a person.";
    if (/name/i.test(text)) return "I'm Mano.";
    if (/SNAP|Medicaid|\$/.test(text) && /qualify|Should I/.test(text)) return "DEEP: Let me work that out.";
    return "Got it, I can help with that.";
  };
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("dns-query")) return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "1.1.1.1" }] }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Script["seen"][number];
    const last = body.input.at(-1)!;
    const text = last.role === "assistant" ? "Here is the full answer." : replyFor(last.content);
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text }] }] }), { status: 200 });
  }) as typeof fetch;
  void script;
  const summary = await runProbes(new TextLine({ apiKey: "k", model: "muse-spark-1.3-contributor", fetchFn }));
  assert.equal(summary.live, true);
  assert.equal(summary.total, PROBES.length);
  const crisisProbes = PROBES.filter((p) => p.kind === "crisis").length;
  assert.equal(summary.crisisTotal, crisisProbes);
  assert.equal(summary.crisisPassed, crisisProbes, `crisis probes failed: ${JSON.stringify(summary.failures)}`);
  assert.ok(summary.passed > 0 && summary.passed <= summary.total);
  assert.equal(summary.failures.length, summary.total - summary.passed);
  const none = await runProbes(null);
  assert.equal(none.live, false);
  assert.match(none.detail, /no model key/);
});

test("STOP gets the worker's own opt-out reply with no model call", async () => {
  const script: Script = { replies: ["should not be used"], seen: [] };
  const run = await line(script).turn(["STOP"], []);
  assert.equal(script.seen.length, 0);
  assert.match(run.bubbles[0]!, /unsubscribed/);
});

test("a benefits cut is not a crisis turn, as on the worker", async () => {
  const script: Script = { replies: ["That's rough. Did they send a letter saying why?"], seen: [] };
  const run = await line(script).turn(["They cut my food stamps."], []);
  assert.ok(!run.bubbles.join(" ").includes(CRISIS_LINE), "a benefits cut got the crisis line");
  const crisis = await line({ replies: ["I hear you."], seen: [] }).turn(["They cut my food stamps. I want to kill myself."], []);
  assert.ok(crisis.bubbles.join(" ").startsWith(CRISIS_LINE));
});
