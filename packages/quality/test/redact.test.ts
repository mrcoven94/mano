// Item 18: model and provider names are stripped from staff-visible strings,
// while ordinary words survive.

import assert from "node:assert/strict";
import test from "node:test";
import { stripModelNames } from "../src/redact.ts";

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
});
