// The letters suite and mail's deadline score read through packages/mail
// whenever a model key is set, and say they are on a stand-in otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadDeadlineReader } from "../src/mail.ts";
import { loadPaths } from "../src/paths.ts";
import { buildLettersCases } from "../src/suites/letters.ts";

const letter = buildLettersCases()[0]!;

test("letters answer through the mail reader when a key is set", async () => {
  const paths = await loadPaths({ META_MODEL_API_KEY: "test-key-not-used" });
  const loaded = paths.forCase(letter);
  assert.equal(loaded.path.name, "mail-reader");
  assert.equal(loaded.standin, false);
  assert.equal(loaded.path.knowsCatalog, false);
  const deadlines = await loadDeadlineReader({ META_MODEL_API_KEY: "test-key-not-used" });
  assert.equal(deadlines.reader.name, "mail-reader");
});

test("letters fall back to the named stand-in without a key", async () => {
  const loaded = (await loadPaths({})).forCase(letter);
  assert.equal(loaded.standin, true);
  assert.match(loaded.detail, /no META_MODEL_API_KEY/);
  const deadlines = await loadDeadlineReader({});
  assert.equal(deadlines.reader.live, false);
  assert.match(deadlines.detail, /no META_MODEL_API_KEY/);
});
