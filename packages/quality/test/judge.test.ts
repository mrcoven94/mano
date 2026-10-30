// Judge: batching, shuffling, parsing, and calibration agreement.

import assert from "node:assert/strict";
import test from "node:test";
import { agreement, buildCalibrationSet } from "../src/calibration.ts";
import { FakeJudge, JUDGE_BATCH_SIZE, MetaJudge, judgeAll, judgeMean, parseJudgeScores } from "../src/judge.ts";
import type { JudgeItem } from "../src/judge.ts";

const item: JudgeItem = { answer: "a", facts: "f", reference: "r" };

test("judge batches hold at most 8", async () => {
  const judge = new FakeJudge();
  await assert.rejects(() => judge.score([]));
  await assert.rejects(() => judge.score(new Array(JUDGE_BATCH_SIZE + 1).fill(item)));
  const scores = await judge.score(new Array(JUDGE_BATCH_SIZE).fill(item));
  assert.equal(scores.length, JUDGE_BATCH_SIZE);
});

test("judgeAll restores input order after shuffling", async () => {
  const items: JudgeItem[] = Array.from({ length: 10 }, (_, i) => ({
    answer: `answer number ${i} with plenty of shared content words here`,
    facts: "facts",
    reference: "answer number shared content words plenty here",
  }));
  const scores = await judgeAll(items, new FakeJudge(), 3);
  assert.equal(scores.length, 10);
  assert.ok(scores.every((s) => s.pass));
});

test("judge output parsing clamps and validates", () => {
  const scores = parseJudgeScores('[{"helpful":9,"accurate":0,"plain":3,"warm":3,"pass":true,"reason":"ok"}]', 1);
  assert.equal(scores[0]!.helpful, 5);
  assert.equal(scores[0]!.accurate, 1);
  assert.equal(scores[0]!.pass, true);
  assert.throws(() => parseJudgeScores("no json here", 1));
  assert.throws(() => parseJudgeScores("[{}]", 2));
});

test("calibration set holds 30 labeled cases, half passing", () => {
  const cal = buildCalibrationSet();
  assert.equal(cal.length, 30);
  assert.equal(cal.filter((c) => c.label).length, 15);
});

test("fake judge agrees with calibration labels over 80%", async () => {
  const cal = buildCalibrationSet();
  const scores = await judgeAll(cal.map((c) => ({ answer: c.answer, facts: c.facts, reference: c.reference })), new FakeJudge(), 99);
  const rate = agreement(scores, cal.map((c) => c.label));
  assert.ok(rate >= 0.8, `agreement ${rate}`);
  assert.ok(judgeMean(scores) > 0);
});

test("judge parse errors never echo the response text", async () => {
  const marker = "HOLDOUT-MARKER-7f3a renewal is due November";
  const replies = [
    `[{"helpful": 5, "reason": "${marker}" ,,]`,
    `${marker} no array at all`,
    `[{"helpful":5,"accurate":5,"plain":5,"warm":5,"pass":true,"reason":"${marker}"}]`,
  ];
  for (const reply of replies) {
    const model = { id: "m", live: true, complete: async () => ({ text: reply, inputTokens: 1, outputTokens: 1 }) };
    const judge = new MetaJudge(model);
    const err = await judgeAll([item, item], judge).then(() => null, (e: unknown) => e as Error);
    assert.ok(err, "judgeAll should reject a malformed reply");
    assert.ok(!err.message.includes("HOLDOUT-MARKER"), `message leaks: ${err.message}`);
    assert.ok(!String(err.stack).includes("HOLDOUT-MARKER"), "stack leaks the response");
    assert.ok(!JSON.stringify(err).includes("HOLDOUT-MARKER"), "error fields leak the response");
    assert.equal((err as { cause?: unknown }).cause, undefined, "cause carries the parser error");
    assert.match(err.message, /^judge reply unusable \([a-z-]+\), sha256 [0-9a-f]{12}$/);
  }
});

test("the judge leaves room for reasoning in a full batch", async () => {
  let asked = 0;
  const model = { id: "m", live: true, complete: async (_m: unknown, opts?: { maxTokens?: number }) => {
    asked = opts?.maxTokens ?? 0;
    return { text: JSON.stringify(new Array(JUDGE_BATCH_SIZE).fill({ helpful: 4, accurate: 4, plain: 4, warm: 4, pass: true, reason: "ok" })), inputTokens: 1, outputTokens: 1 };
  } };
  await new MetaJudge(model).score(new Array(JUDGE_BATCH_SIZE).fill(item));
  assert.ok(asked >= 8192, `judge capped at ${asked} tokens`);
});
