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

test("smoke watches every path that can change what Mano says", () => {
  for (const path of ["packages/persona/**", "packages/channels/**", "apps/channels/**", "packages/mail/**", "packages/guardian/**", "apps/engine/**", "packages/quality/**", ".github/workflows/quality-*.yml"]) {
    assert.ok(smoke.includes(`"${path}"`), `smoke misses ${path}`);
  }
});

test("the gate outcome is data, never a shell exit code", () => {
  assert.ok(!smoke.includes("$?"), "a step reads an exit code");
  assert.ok(!smoke.includes("GITHUB_ENV"), "the outcome rides the environment");
  assert.ok(smoke.includes("checks: write"), "the check run needs checks permission");
  assert.match(smoke, /- name: Post the result\n\s+if: always\(\)/, "publishing must run after a failed or neutral smoke step");
});

test("nightly runs on main with every live part and records to both buckets", () => {
  assert.match(nightly, /schedule:\n\s+- cron:/, "the nightly runs on a schedule, which GitHub runs on main");
  assert.ok(nightly.includes("workflow_dispatch"), "a branch can run it by hand");
  assert.ok(!/^ *if:.*secrets\./m.test(nightly), "nightly gates a step on a secret");
  assert.ok(nightly.includes("HOLDOUT: ${{ secrets.MANO_QUALITY_HOLDOUT }}"), "holdout must ride env");
  assert.ok(!nightly.includes("printf '%s' '${{"), "holdout is pasted into shell source");
  for (const name of ["MANO_GUARDIAN_URL", "MANO_GUARDIAN_TOKEN", "MANO_GUARDIAN_KEY_ID", "MANO_GUARDIAN_KEY_SECRET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    assert.ok(nightly.includes(`secrets.${name}`), `nightly misses ${name}`);
  }
  assert.ok(nightly.includes("--upload"), "nightly never records the run");
});
