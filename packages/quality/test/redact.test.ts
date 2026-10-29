// Item 18: model and provider names are stripped from staff-visible strings,
// while ordinary words survive.

import assert from "node:assert/strict";
import test from "node:test";
import { scrubStaffCase, stripModelNames } from "../src/redact.ts";

test("strips model families, versions, IDs, and providers", () => {
  assert.equal(stripModelNames("Scored by Muse Spark 1.3 via Meta"), "Scored by [model] via [model]");
  assert.equal(stripModelNames("judge:muse-spark-1.3-contributor"), "[model]");
  assert.equal(stripModelNames("muse-wonder beat gpt-4o and claude-3"), "[model] beat [model] and [model]");
  assert.equal(stripModelNames("OpenAI, Anthropic, Google DeepMind, xAI, Deepgram"), "[model], [model], [model], [model], [model]");
  assert.equal(stripModelNames("llama and gemini 2.0 flash"), "[model] and [model]");
});

test("leaves ordinary words alone", () => {
  assert.equal(stripModelNames("a metal detector is a metaphor"), "a metal detector is a metaphor");
  assert.equal(stripModelNames("Your SNAP renewal is due November 15, 2026."), "Your SNAP renewal is due November 15, 2026.");
  assert.equal(stripModelNames("Sam called about the command results"), "Sam called about the command results");
});

test("strips every listed model and product name", () => {
  assert.equal(stripModelNames("split by SAM 3.1"), "split by [model]");
  assert.equal(stripModelNames("read with SAM 3"), "read with [model]");
  assert.equal(stripModelNames("heard by Voice Transcribe"), "heard by [model]");
  assert.equal(stripModelNames("heard by Muse Voice Transcribe"), "heard by [model]");
  assert.equal(stripModelNames("drawn with Image Generation"), "drawn with [model]");
  assert.equal(stripModelNames("filled with Computer Use"), "filled with [model]");
  assert.equal(stripModelNames("muse-spark-1.3-contributor"), "[model]");
  assert.equal(stripModelNames("groq or mixtral"), "groq or [model]");
});

test("staff scrubbing cleans answers, details, and reasons", () => {
  const cleaned = scrubStaffCase({
    caseId: "x", suite: "chat",
    answer: { text: "Split by SAM 3.1 for you." },
    checks: [{ id: "a", pass: false, detail: "judge:muse-spark-1.3 said no" }, { id: "b", pass: true }],
    judge: { helpful: 1, accurate: 1, plain: 1, warm: 1, pass: false, reason: "Voice Transcribe misheard" },
  });
  assert.equal(cleaned.answer.text, "Split by [model] for you.");
  assert.equal(cleaned.checks[0]!.detail, "[model] said no");
  assert.equal(cleaned.checks[1]!.detail, undefined);
  assert.equal(cleaned.judge!.reason, "[model] misheard");
});
