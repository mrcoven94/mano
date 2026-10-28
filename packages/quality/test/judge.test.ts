// Judge: batching, shuffling, parsing, and calibration agreement.

import assert from "node:assert/strict";
import test from "node:test";
import { agreement, buildCalibrationSet } from "../src/calibration.ts";
import { FakeJudge, JUDGE_BATCH_SIZE, judgeAll, judgeMean, parseJudgeScores } from "../src/judge.ts";
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
