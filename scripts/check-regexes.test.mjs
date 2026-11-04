// Run with: node --test scripts/check-regexes.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { inScope, scanFile, scanFiles } from "./check-regexes.mjs";

const lines = (source) => scanFile("apps/x/src/a.ts", source).map((issue) => issue.line);

test("reports a regex literal, new RegExp and RegExp() inside a function", () => {
  assert.deepEqual(lines("function f(s) {\n  return /a/.test(s);\n}\n"), [2]);
  assert.deepEqual(lines("const f = (s) => new RegExp(s);\n"), [1]);
  assert.deepEqual(lines("const f = (s) => RegExp(s);\n"), [1]);
  assert.deepEqual(lines("class A {\n  m(s) {\n    return s.replace(/a/, '');\n  }\n}\n"), [3]);
  assert.deepEqual(lines("const o = {\n  m(s) {\n    return /a/.test(s);\n  },\n};\n"), [3]);
});

test("reports a default argument and an instance field, which run per call", () => {
  assert.deepEqual(lines("function f(re = /a/) {\n  return re;\n}\n"), [1]);
  assert.deepEqual(lines("class A {\n  re = /a/;\n}\n"), [2]);
});

test("allows module-level regexes and code that runs once at load", () => {
  assert.deepEqual(lines("const A = /a/;\nconst B = new RegExp('b');\n"), []);
  assert.deepEqual(lines("const A = ['a'].map((s) => new RegExp(s));\n"), []);
  assert.deepEqual(lines("const A = (() => /a/)();\n"), []);
  assert.deepEqual(lines("const A = Array.from(['a'], (s) => new RegExp(s));\n"), []);
  assert.deepEqual(lines("class A {\n  static re = /a/;\n}\n"), []);
});

test("reports a function that only looks like a load-time builder", () => {
  // Inside a function the .map runs on every call.
  assert.deepEqual(lines("function f(xs) {\n  return xs.map((s) => new RegExp(s));\n}\n"), [2]);
  // The returned function runs later, and an unknown wrapper may run its callback later too.
  assert.deepEqual(lines("const A = ['a'].map((s) => () => new RegExp(s));\n"), [1]);
  assert.deepEqual(lines("const A = later(() => /a/);\n"), [1]);
  assert.deepEqual(lines("app.get('/', () => /a/);\n"), [1]);
});

test("a marker with a reason allows a regex on its line or the line below", () => {
  assert.deepEqual(lines("function f(s) {\n  // regex-ok: built from this person's name\n  return new RegExp(s);\n}\n"), []);
  assert.deepEqual(lines("function f(s) {\n  return new RegExp(s); // regex-ok: built from this person's name\n}\n"), []);
});

test("a marker needs a reason and something to allow", () => {
  assert.deepEqual(lines("function f(s) {\n  // regex-ok:\n  return new RegExp(s);\n}\n"), [2]);
  assert.deepEqual(lines("// regex-ok: nothing here\nconst A = /a/;\n"), [1]);
  // Two lines up is too far.
  assert.deepEqual(lines("function f(s) {\n  // regex-ok: too far\n  const x = 1;\n  return new RegExp(s);\n}\n"), [2, 4]);
});

test("reports .test and .exec on a shared g or y regex", () => {
  assert.deepEqual(lines("const A = /a/g;\nconst f = (s) => A.test(s);\n"), [2]);
  assert.deepEqual(lines("const A = /a/y;\nconst f = (s) => A.exec(s);\n"), [2]);
  assert.deepEqual(lines("const A = new RegExp('a', 'gi');\nconst f = (s) => A.test(s);\n"), [2]);
  assert.deepEqual(lines("const A = /a/g as RegExp;\nconst f = (s) => A.test(s);\n"), [2]);
  assert.deepEqual(lines("const A = wrap(/a/g);\nconst f = (s) => A.test(s);\n"), [2]);
});

test("reports .test on a g regex reached through a shared array", () => {
  assert.deepEqual(lines("const A = [/a/, /b/g];\nconst f = (s) => A.some((re) => re.test(s));\n"), [2]);
  assert.deepEqual(lines("const A = [/a/g];\nfunction f(s) {\n  for (const re of A) re.exec(s);\n}\n"), [3]);
  assert.deepEqual(lines("const A = [/a/g];\nconst f = (s) => A[0].test(s);\n"), [2]);
});

test("RegExp keeps the flags of the regex it copies unless it is given new ones", () => {
  assert.deepEqual(lines("const A = new RegExp(/a/g);\nconst f = (s) => A.test(s);\n"), [2]);
  assert.deepEqual(lines("const A = new RegExp(/a/g, 'i');\nconst f = (s) => A.test(s);\n"), []);
  assert.deepEqual(lines("const A = new RegExp(/a/i);\nconst f = (s) => A.test(s);\n"), []);
});

test("allows the calls that do not depend on lastIndex", () => {
  assert.deepEqual(lines("const A = /a/;\nconst f = (s) => A.test(s);\n"), []);
  assert.deepEqual(lines("const A = /a/g;\nconst f = (s) => [s.replace(A, ''), s.match(A), [...s.matchAll(A)]];\n"), []);
  assert.deepEqual(lines("const A = [/a/];\nconst f = (s) => A.some((re) => re.test(s));\n"), []);
  // Same names, unrelated values.
  assert.deepEqual(lines("const A = /a/;\nconst B = [/b/g];\nconst f = (re, s) => re.test(s);\n"), []);
});

test("follows a shared g regex across an import, under its alias too", () => {
  const shared = { path: "packages/x/src/shared.ts", text: "export const A = /a/g;\nconst B = /b/g;\nexport { B as C };\nconst D = /d/g;\n" };
  const scan = (text) => scanFiles([shared, { path: "apps/x/src/a.ts", text }]).filter((i) => i.path === "apps/x/src/a.ts").map((i) => i.line);
  assert.deepEqual(scan("import { A } from '@mano/x';\nconst f = (s) => A.test(s);\n"), [2]);
  assert.deepEqual(scan("import { A as Z } from '@mano/x';\nconst f = (s) => Z.exec(s);\n"), [2]);
  assert.deepEqual(scan("import { C } from '@mano/x';\nconst f = (s) => C.test(s);\n"), [2]);
  // D is not exported, so this D is some other value.
  assert.deepEqual(scan("import { D } from '@mano/y';\nconst f = (s) => D.test(s);\n"), []);
});

test("scope covers runtime source under apps and packages only", () => {
  for (const path of ["apps/engine/src/index.ts", "packages/mail/src/safety.ts", "apps/app/app/approvals/[id].tsx", "apps/site/lib/a.js"]) {
    assert.equal(inScope(path), true, path);
  }
  for (const path of [
    "apps/engine/test/a.ts", "apps/engine/test-node/a.ts", "apps/channels/test-worker/a.ts", "packages/mail/src/a.test.ts",
    "apps/agent/evals/a.ts", "packages/guardian/eval/a.ts", "packages/mail/scripts/a.ts", "packages/computer/probe/a.ts",
    "packages/programs/sources/verify.sources.ts", "apps/engine/worker-configuration.d.ts", "apps/site/next.config.mjs",
    "eval/a.ts", "scripts/status.mjs", "apps/engine/src/a.json",
  ]) {
    assert.equal(inScope(path), false, path);
  }
});
