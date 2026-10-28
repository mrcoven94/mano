// Suite shape: counts, states, languages, versions, and pins. Any changed case
// fails here until the version is bumped and the pin refreshed on purpose.

import assert from "node:assert/strict";
import test from "node:test";
import { buildAllSuites, buildSuite } from "../src/suites/build.ts";
import { SUITE_PINS } from "../src/suites/pins.ts";
import { SMOKE_CASE_COUNT, SMOKE_CASE_IDS } from "../src/smoke.ts";

test("suites hold the specified case counts", () => {
  assert.equal(buildSuite("chat").cases.length, 40);
  assert.equal(buildSuite("text").cases.length, 25);
  assert.equal(buildSuite("letters").cases.length, 20);
  assert.equal(buildSuite("safety").cases.length, 40);
});

test("suite builds are deterministic and match the committed pins", () => {
  for (const build of buildAllSuites()) {
    const pin = SUITE_PINS[build.suite];
    assert.ok(pin, `no pin for ${build.suite}`);
    assert.equal(build.version, pin.version);
    assert.equal(build.cases.length, pin.cases);
    assert.equal(build.sha256, pin.sha256);
  }
  const again = buildAllSuites().map((s) => s.sha256).join(",");
  const first = buildAllSuites().map((s) => s.sha256).join(",");
  assert.equal(again, first);
});

test("chat spans at least 8 states in English and Spanish", () => {
  const cases = buildSuite("chat").cases;
  const states = new Set(cases.map((c) => c.state));
  assert.ok(states.size >= 8, `only ${states.size} states`);
  assert.ok(cases.some((c) => c.locale === "es"));
  assert.ok(cases.some((c) => c.locale === "en"));
});

test("text covers multi-turn, photo, STOP, and cannot-help", () => {
  const cats = new Set(buildSuite("text").cases.map((c) => c.category));
  for (const cat of ["multi-turn", "photo", "stop", "cannot-help"]) {
    assert.ok(cats.has(cat), `missing ${cat}`);
  }
  const multi = buildSuite("text").cases.find((c) => c.category === "multi-turn")!;
  assert.equal(multi.input.turns.length, 3);
});

test("safety covers every required category", () => {
  const cats = buildSuite("safety").cases.map((c) => c.category);
  for (const cat of ["crisis", "crisis-lookalike", "planted-instruction", "scam", "act-for-other", "judgment"]) {
    assert.ok(cats.includes(cat), `missing ${cat}`);
  }
});

test("letters cases carry a synthetic image and a citation", () => {
  for (const c of buildSuite("letters").cases) {
    assert.equal(c.input.images?.length, 1);
    assert.ok(c.input.images![0]!.svg.includes("SYNTHETIC TEST LETTER"));
    assert.ok(c.reference.includes("[letter 1]"));
  }
});

test("every person named is synthetic and every fixture phone is fictional", () => {
  for (const build of buildAllSuites()) {
    for (const c of build.cases) {
      for (const phone of c.facts.allowedPhones) {
        const digits = phone.replace(/\D/g, "");
        assert.ok(digits === "988" || digits.startsWith("55501"), `non-fictional phone ${phone} in ${c.id}`);
      }
      for (const url of c.facts.allowedUrls) {
        assert.ok(new URL(url).host.endsWith(".example"), `non-example link ${url} in ${c.id}`);
      }
    }
  }
});

test("smoke subset holds 25 real case ids", () => {
  assert.equal(SMOKE_CASE_IDS.length, SMOKE_CASE_COUNT);
  assert.equal(new Set(SMOKE_CASE_IDS).size, SMOKE_CASE_COUNT);
  const ids = new Set(buildAllSuites().flatMap((s) => s.cases.map((c) => c.id)));
  for (const id of SMOKE_CASE_IDS) assert.ok(ids.has(id), `smoke id ${id} not found`);
});
