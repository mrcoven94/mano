// Live hooks: blocking, sampling, masking that spares danger words, counters,
// feedback, suppression, and the proof that no live text is stored.

import assert from "node:assert/strict";
import test from "node:test";
import { factsForState } from "../src/facts.ts";
import { LocalDns } from "../src/links.ts";
import { FakeJudge } from "../src/judge.ts";
import { LiveQuality, maskText, sampleForJudge, suppressCounts } from "../src/live.ts";
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
