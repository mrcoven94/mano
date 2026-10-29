// Live hooks: blocking, sampling, masking that spares danger words, counters,
// feedback, suppression, and the proof that no live text is stored.

import assert from "node:assert/strict";
import test from "node:test";
import { factsForState } from "../src/facts.ts";
import { LocalDns } from "../src/links.ts";
import { FakeJudge, type JudgeClient } from "../src/judge.ts";
import { LiveQuality, displayTotal, expectedJudgeId, gradingPayload, inboundNeedsCrisis, maskText, sampleForJudge, suppressCounts } from "../src/live.ts";
import { MemoryLiveStore } from "../src/live-store.ts";

const WEEK = "2026-W44";

function hooks() {
  const store = new MemoryLiveStore();
  const live = new LiveQuality({ store, dns: new LocalDns(), judge: new FakeJudge() });
  return { store, live };
}

const SYNTHETIC_MESSAGE = "My name is Test Person, reach me at test-person-7419@example.net about case ZX-7419-QQ";

test("invented facts and unsafe links block the answer before sending", async () => {
  const { store, live } = hooks();
  const blocked = await live.afterAnswer({
    answerId: "block-1", text: `Your renewal is due. Call (555) 999-0000 or visit http://secure-login-benefits.example/x now.`,
    category: "deadlines", locale: "en", state: "CA", week: WEEK, facts: factsForState("CA", false),
    textChannel: false, latencyMs: 120, inputTokens: 50, outputTokens: 40,
  });
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.failedChecks.includes("facts-grounded"));
  assert.ok(blocked.failedChecks.includes("links-ok"));
  assert.equal(store.answerOutcomes()[0]!.blocked, true);

  const allowed = await live.afterAnswer({
    answerId: "allow-1", text: "Your SNAP renewal is due November 15, 2026. Send a photo ID, pay stub, and rent receipt.",
    category: "deadlines", locale: "en", state: "CA", week: WEEK, facts: factsForState("CA", false),
    textChannel: false, latencyMs: 100, inputTokens: 50, outputTokens: 40,
  });
  assert.equal(allowed.blocked, false);
});

test("sampling hits about one answer in twenty, stably", () => {
  let hits = 0;
  for (let i = 0; i < 2000; i++) if (sampleForJudge(`answer-${i}`)) hits++;
  assert.ok(hits > 40 && hits < 180, `${hits} samples out of 2000`);
  assert.equal(sampleForJudge("stable-id"), sampleForJudge("stable-id"));
});

test("masking removes personal details but keeps danger words", () => {
  const masked = maskText("My name is Rosa Mendez, call me at (555) 010-1101 or rosa-7419@example.net. I live at 7419 Willow Lane. Case ZX-7419. I want to hurt myself tonight, I took some pills, this is an emergency, it may be a scam.");
  assert.ok(!masked.includes("Rosa Mendez"));
  assert.ok(!masked.includes("(555) 010-1101"));
  assert.ok(!masked.includes("rosa-7419@example.net"));
  assert.ok(!masked.includes("7419 Willow Lane"));
  assert.ok(!masked.includes("ZX-7419"));
  for (const word of ["hurt myself", "pills", "emergency", "scam"]) {
    assert.ok(masked.includes(word), `masking erased ${word}`);
  }
});

test("masking catches greetings, SSNs, lowercase addresses, and token links", () => {
  assert.equal(maskText("Hi Rosa Mendez, thanks for writing"), "[greeting], thanks for writing");
  assert.equal(maskText("Thanks, Rosa, I will call"), "[greeting], I will call");
  assert.equal(maskText("my ssn is 123-45-6789"), "my ssn is [ssn]");
  assert.equal(maskText("number 987654321 here"), "number [id-number] here");
  assert.equal(maskText("id 987654321 here"), "[case-number] here");
  assert.equal(maskText("i live at 42 willow lane now"), "i live at [address] now");
  assert.equal(maskText("open https://office.example/renew?token=abc123 now"), "open [link] now");
  assert.equal(maskText("Hi there, I need help"), "Hi there, I need help");
  assert.equal(maskText("Thank you. Call Rosa tomorrow"), "Thank you. Call Rosa tomorrow");
  assert.equal(maskText("hi rosa, are you there"), "[greeting], are you there");
  assert.equal(maskText("thanks juan perez for the photo"), "[greeting] for the photo");
  assert.equal(maskText("hello everyone, good news"), "hello everyone, good news");
});

test("the grading payload masks the facts too", () => {
  const payload = gradingPayload("Call me please", "phones: (555) 010-1101\nlinks: https://office.example/renew?token=abc123");
  assert.ok(!payload.facts.includes("(555) 010-1101"));
  assert.ok(!payload.facts.includes("token=abc123"));
});

test("live grading accepts only the exact judge identity", () => {
  const store = new MemoryLiveStore();
  const env = { MANO_MODEL_JUDGE_ID: "muse-spark-1.3" };
  const contributor: JudgeClient = { id: "judge:idl-1.0-contributor", live: true, score: async () => [] };
  assert.throws(() => new LiveQuality({ store, judge: contributor, env }), /requires judge/);
  const other: JudgeClient = { id: "judge:some-other-model", live: true, score: async () => [] };
  assert.throws(() => new LiveQuality({ store, judge: other, env }), /requires judge/);
  const exact: JudgeClient = { id: "judge:muse-spark-1.3", live: true, score: async () => [] };
  assert.doesNotThrow(() => new LiveQuality({ store, judge: exact, env }));
  assert.doesNotThrow(() => new LiveQuality({ store, judge: new FakeJudge() }));
  assert.equal(expectedJudgeId({ env }), "judge:muse-spark-1.3");
  assert.equal(expectedJudgeId({ judgeId: "custom-id" }), "judge:custom-id");
});

test("counters, feedback, and suppression keep counts only", () => {
  const { store, live } = hooks();
  live.classifyConversation({ state: "CA", week: WEEK, kind: "benefits", urgency: "routine", helped: true });
  live.classifyConversation({ state: "CA", week: WEEK, kind: "benefits", urgency: "routine", helped: false });
  live.recordFeedback({ category: "deadlines", channel: "web", helpful: true, week: WEEK });
  live.recordFeedback({ category: "deadlines", channel: "text", helpful: false, week: WEEK });
  assert.equal(store.counters().length, 2);
  assert.equal(store.feedback().length, 2);

  const suppressed = suppressCounts(
    [{ label: "benefits", n: 42 }, { label: "calls", n: 3 }],
    45,
  );
  assert.deepEqual(suppressed.shown, [{ label: "benefits", n: 42 }]);
  assert.equal(suppressed.hiddenCells, 1);
  assert.equal(suppressed.total, null);

  const open = suppressCounts(
    [{ label: "benefits", n: 42 }, { label: "forms", n: 11 }],
    53,
  );
  assert.equal(open.total, 53);
});

test("suppression withholds totals so hidden cells cannot be recovered", () => {
  // 42, 9, 9 with a total of 60 would reveal both hidden cells.
  const r = suppressCounts(
    [{ label: "benefits", n: 42 }, { label: "calls", n: 9 }, { label: "mail", n: 9 }],
    60,
  );
  assert.deepEqual(r.shown, [{ label: "benefits", n: 42 }]);
  assert.equal(r.hiddenCells, 2);
  assert.equal(r.total, null);
  assert.equal(displayTotal(1, 60), null);
  assert.equal(displayTotal(0, 60), 60);
  assert.equal(displayTotal(0, 9), null);
});

test("extra fields never reach the store", () => {
  const { store, live } = hooks();
  live.classifyConversation({ state: "CA", week: WEEK, kind: "benefits", urgency: "routine", helped: true, text: "SECRET-COUNTER" } as never);
  live.recordFeedback({ category: "deadlines", channel: "web", helpful: true, week: WEEK, text: "SECRET-VOTE" } as never);
  store.incrementCounter({ state: "CA", week: WEEK, kind: "x", urgency: "routine", helped: true, text: "SECRET-DIRECT" } as never);
  const dumped = store.snapshot();
  assert.ok(!dumped.includes("SECRET-COUNTER"));
  assert.ok(!dumped.includes("SECRET-VOTE"));
  assert.ok(!dumped.includes("SECRET-DIRECT"));
});

test("live blocking enforces every safety check, including crisis", async () => {
  const { live } = hooks();
  const base = {
    answerId: "x", category: "programs", locale: "en" as const, state: "CA", week: WEEK,
    facts: factsForState("CA", true), textChannel: false, latencyMs: 10, inputTokens: 1, outputTokens: 1,
  };
  const promised = await live.afterAnswer({ ...base, answerId: "promise-1", text: "You are approved, guaranteed." });
  assert.equal(promised.blocked, true);
  assert.ok(promised.failedChecks.includes("no-promise"));

  const crisisMissed = await live.afterAnswer({
    ...base, answerId: "crisis-1", inboundText: "I want to hurt myself tonight.",
    text: "Tell me about your renewal and we will sort it out.",
  });
  assert.equal(crisisMissed.blocked, true);
  assert.ok(crisisMissed.failedChecks.includes("crisis-ok"));

  const crisisMet = await live.afterAnswer({
    ...base, answerId: "crisis-2", inboundText: "I want to hurt myself tonight.",
    text: "Please call or text 988 now for the Suicide and Crisis Lifeline.",
  });
  assert.equal(crisisMet.blocked, false);

  assert.equal(inboundNeedsCrisis("This deadline is killing me"), false);
  assert.equal(inboundNeedsCrisis("My phone died"), false);
  assert.equal(inboundNeedsCrisis("Quiero hacerme daño"), true);
});

test("the live judge grades the sent bubbles, masked", async () => {
  const seen: string[] = [];
  const capturing: JudgeClient = {
    id: "capturing-judge", live: false,
    score: async (batch) => {
      for (const item of batch) seen.push(item.answer);
      return batch.map(() => ({ helpful: 5, accurate: 5, plain: 5, warm: 5, pass: true, reason: "" }));
    },
  };
  const store = new MemoryLiveStore();
  const live = new LiveQuality({ store, dns: new LocalDns(), judge: capturing });
  const ids: string[] = [];
  for (let i = 0; ids.length < 1; i++) {
    if (sampleForJudge(`bubbles-${i}`)) ids.push(`bubbles-${i}`);
  }
  await live.afterAnswer({
    answerId: ids[0]!, text: "WRONG SUMMARY",
    bubbles: ["Your SNAP renewal is due November 15, 2026.", "Thanks, Rosa."],
    category: "deadlines", locale: "en", state: "CA", week: WEEK, facts: factsForState("CA", false),
    textChannel: true, latencyMs: 10, inputTokens: 1, outputTokens: 1,
  });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.includes("WRONG SUMMARY"));
  assert.ok(seen[0]!.includes("November 15, 2026"));
  assert.ok(!seen[0]!.includes("Rosa"));
});

test("no live text is stored anywhere", async () => {
  const { store, live } = hooks();
  // Drive every hook with a synthetic message carrying a unique marker, then
  // search everything the hooks wrote for any fragment of it. The ids are
  // picked so at least two answers are sampled for in-place grading.
  const ids: string[] = [];
  for (let i = 0; ids.length < 40; i++) {
    const id = `notext-${i}`;
    if (ids.length < 38 || sampleForJudge(id)) ids.push(id);
  }
  assert.ok(ids.filter(sampleForJudge).length >= 2, "test needs sampled ids");
  for (let i = 0; i < ids.length; i++) {
    await live.afterAnswer({
      answerId: ids[i]!, text: `${SYNTHETIC_MESSAGE} number ${i}. Your SNAP renewal is due November 15, 2026.`,
      category: "deadlines", locale: "en", state: "CA", week: WEEK, facts: factsForState("CA", false),
      textChannel: i % 2 === 0, latencyMs: 100, inputTokens: 10, outputTokens: 10,
    });
  }
  live.classifyConversation({ state: "CA", week: WEEK, kind: "benefits", urgency: "routine", helped: true });
  live.recordFeedback({ category: "deadlines", channel: "web", helpful: true, week: WEEK });

  const dumped = store.snapshot();
  for (const fragment of ["Test Person", "test-person-7419", "ZX-7419-QQ", "example.net", "renewal is due November"]) {
    assert.ok(!dumped.includes(fragment), `store leaks ${fragment}`);
  }
  assert.ok(dumped.includes("deadlines"), "counts are still recorded");
  assert.ok(store.answerOutcomes().length === 40);
  assert.ok(store.judgeSamples().length >= 1, "some answers were sampled");
});
