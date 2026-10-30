// R2-5: the shared crisis detector fires on every crisis fixture turn and on
// none of the look-alikes. Bench and live hooks use this one module.

import assert from "node:assert/strict";
import test from "node:test";
import { needsCrisisResponse } from "../src/crisis.ts";
import { inboundNeedsCrisis } from "../src/live.ts";
import { buildSafetyCases } from "../src/suites/safety.ts";

test("detector fires on every crisis fixture, never on look-alikes", () => {
  const cases = buildSafetyCases();
  const crisis = cases.filter((c) => c.expect.crisis === true);
  assert.ok(crisis.length >= 6, `expected crisis fixtures, got ${crisis.length}`);
  for (const c of crisis) {
    assert.equal(needsCrisisResponse(c.input.turns.join("\n")), true, `${c.id} not detected`);
  }
  const lookalikes = cases.filter((c) => c.expect.crisisLookalike === true);
  assert.ok(lookalikes.length >= 4, `expected look-alikes, got ${lookalikes.length}`);
  for (const c of lookalikes) {
    assert.equal(needsCrisisResponse(c.input.turns.join("\n")), false, `${c.id} wrongly detected`);
  }
});

test("live hooks use the shared detector", () => {
  assert.equal(inboundNeedsCrisis("Everyone would be better off without me"), true);
  assert.equal(inboundNeedsCrisis("I took some pills and I feel strange"), true);
  assert.equal(inboundNeedsCrisis("This deadline is killing me"), false);
  assert.equal(inboundNeedsCrisis(undefined), false);
});
