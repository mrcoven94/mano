// Alerts fire past the gate thresholds with numbers only; the holdout loader
// refuses unverified files.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alertBody, evalAlert, postToLinearTicket } from "../src/alerts.ts";
import { loadHoldout, HOLDOUT_VERSION, HOLDOUT_CASE_COUNT } from "../src/holdout.ts";
import { sha256Hex } from "../src/prng.ts";
import { buildSafetyCases } from "../src/suites/safety.ts";

test("alerts fire past the gate thresholds and stay quiet otherwise", () => {
  const baseline = { hardFailRate: 0.02, judgeMean: 4.5 };
  const bad = evalAlert({ answers: 1000, hardFailRate: 0.09, judgeMean: 4.1, judgeSamples: 50 }, baseline);
  assert.equal(bad.fire, true);
  assert.equal(bad.reasons.length, 2);
  const ok = evalAlert({ answers: 1000, hardFailRate: 0.03, judgeMean: 4.4, judgeSamples: 50 }, baseline);
  assert.equal(ok.fire, false);
  assert.equal(evalAlert({ answers: 0, hardFailRate: 1, judgeMean: null, judgeSamples: 0 }, baseline).fire, false);
  const body = alertBody({ answers: 1000, hardFailRate: 0.09, judgeMean: 4.1, judgeSamples: 50 }, bad.reasons, "2026-10-28");
  assert.match(body, /1000/);
  assert.match(body, /numbers only/);
});

test("Linear poster finds the ticket by number and posts numbers only", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    const asked = JSON.parse(init.body) as { variables: Record<string, unknown> };
    const json = asked.variables.num !== undefined
      ? { data: { issues: { nodes: [{ id: "issue-1" }] } } }
      : { data: { commentCreate: { comment: { id: "comment-1" } } } };
    return { json: async () => json };
  }) as unknown as typeof fetch;
  const out = await postToLinearTicket({ apiUrl: "https://linear.test/graphql", apiKey: "k", fetchFn }, "LAP-567", "numbers only");
  assert.deepEqual(out, { issueId: "issue-1", commentId: "comment-1" });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.body.includes("numbers only"));
});

test("holdout loader verifies the hash and the shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "quality-holdout-"));
  const cases = buildSafetyCases().slice(0, HOLDOUT_CASE_COUNT);
  const raw = JSON.stringify({ version: HOLDOUT_VERSION, cases });
  const path = join(dir, "holdout.json");
  writeFileSync(path, raw);

  assert.equal(loadHoldout(undefined, undefined).configured, false);
  assert.equal(loadHoldout(path, undefined).configured, false);
  assert.equal(loadHoldout(path, "0".repeat(64)).configured, false);
  const good = loadHoldout(path, sha256Hex(raw));
  assert.equal(good.configured, true);
  assert.equal(good.cases!.length, HOLDOUT_CASE_COUNT);

  const sha = sha256Hex(raw);
  assert.equal(loadHoldout(path, sha, sha).configured, true);
  const pinned = loadHoldout(path, sha, "f".repeat(64));
  assert.equal(pinned.configured, false);
  assert.equal(pinned.pinMatch, false);
  assert.match(pinned.reason!, /committed pin/);

  const wrongCount = join(dir, "short.json");
  writeFileSync(wrongCount, JSON.stringify({ version: HOLDOUT_VERSION, cases: cases.slice(0, 5) }));
  assert.equal(loadHoldout(wrongCount, sha256Hex(JSON.stringify({ version: HOLDOUT_VERSION, cases: cases.slice(0, 5) }))).configured, false);
});
