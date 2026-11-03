// The judge run's copy of the replay page: a banner and a label on every
// simulated item, added to Engine's page and nothing else changed.

import assert from "node:assert/strict";
import test from "node:test";
import { labelReplayPage, withoutJudgeLabels } from "../src/judge-replay.ts";

// The shape Engine's stepsPage writes for an approved fill of two steps.
const ENGINE_PAGE =
  '<!doctype html><html lang="en"><head><title>Your form, step by step</title></head><body><main>' +
  "<h1>Food benefits renewal</h1><p>You said yes to this version.</p>" +
  '<ol><li><p>1. Mano opened the form.</p><img src="data:image/png;base64,AA" alt="The form after this step"></li>' +
  '<li><p>2. Mano filled in &quot;Case number&quot;.</p><div class="zoom"><img src="data:image/png;base64,AA" alt="Close-up"></div></li></ol>' +
  '<h2>The filled form</h2><img src="data:image/png;base64,AA" alt="The whole form, filled">' +
  "<h2>What you said yes to</h2><dl><div><dt>Case number</dt><dd>R-1042</dd></div></dl></main></body></html>";

test("the judge's copy labels the run and every simulated item", () => {
  const page = labelReplayPage(ENGINE_PAGE, ["Maria's YES: scripted, since Maria is synthetic."]);
  assert.match(page, /<main><div class="judge-label"><p><strong>Judge run on synthetic data\.<\/strong>/);
  assert.match(page, /<li>Maria&#39;s YES: scripted, since Maria is synthetic\.<\/li>/);
  assert.match(page, /<p>You said yes to this version\.<\/p><div class="judge-label"><p><strong>Simulated: Maria is synthetic, and this run scripted her YES\.<\/strong>/);
  assert.equal(page.match(/Simulated: a screen drawn by the stand-in for Mano&#39;s computer/g)?.length, 3);
});

test("without the labels the page is exactly Engine's", () => {
  assert.equal(withoutJudgeLabels(labelReplayPage(ENGINE_PAGE, ["x"])), ENGINE_PAGE);
  assert.equal(withoutJudgeLabels(ENGINE_PAGE), ENGINE_PAGE);
});

test("a page with no place for the labels throws instead of dropping them", () => {
  assert.throws(() => labelReplayPage("<main><h1>This page is not available</h1></main>", ["x"]), /no place/);
});
