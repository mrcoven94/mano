// Workflow shape: the quality gates read the right secrets, assert the model
// IDs differ, watch every path that can change answers, and pass secrets
// through env, never through shell source or `if:` conditions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const smoke = readFileSync(join(root, ".github", "workflows", "quality-smoke.yml"), "utf8");
const nightly = readFileSync(join(root, ".github", "workflows", "quality-nightly.yml"), "utf8");

test("workflows use the repo Meta key and plain model ID variables", () => {
  for (const [name, text] of [["smoke", smoke], ["nightly", nightly]] as const) {
    assert.ok(text.includes("secrets.META_MODEL_API_KEY"), `${name} misses the Meta key`);
    assert.ok(!text.includes("secrets.MANO_MODEL_API_KEY"), `${name} uses the wrong key name`);
    assert.ok(!text.includes("secrets.MANO_MODEL_BENCH_ID"), `${name} hides a model ID in secrets`);
    assert.ok(text.includes("vars.MANO_MODEL_JUDGE_ID"), `${name} misses the judge ID variable`);
    assert.ok(text.includes("vars.MANO_MODEL_BENCH_ID"), `${name} misses the serving ID variable`);
    assert.ok(text.includes("must differ"), `${name} never asserts the IDs differ`);
    assert.ok(text.includes("Require the model key"), `${name} never fails fast without a key`);
  }
});

test("smoke watches every path that can change answers", () => {
  for (const path of ["apps/engine/**", "apps/channels/**", "packages/channels/**", "packages/mail/**", "packages/quality/**", ".github/workflows/quality-*.yml"]) {
    assert.ok(smoke.includes(path), `smoke misses ${path}`);
  }
});

test("nightly handles secrets through env only", () => {
  assert.ok(!/^ *if:.*secrets\./m.test(nightly), "nightly gates a step on a secret");
  assert.ok(nightly.includes("HOLDOUT: ${{ secrets.MANO_QUALITY_HOLDOUT }}"), "holdout must ride env");
  assert.ok(!nightly.includes("printf '%s' '${{"), "holdout is pasted into shell source");
  assert.ok(nightly.includes('printf \'%s\' "$HOLDOUT"'), "holdout is not written from env");
  assert.ok(nightly.includes("s3://mano-quality/private"), "private runs have no upload path");
});
