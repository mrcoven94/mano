// The judge command end to end, as a judge runs it: once with no key, and
// once with a key whose model API answers 402 (billing not set up), which
// must say so on the model steps, finish on the recordings and exit 1.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const QUALITY = join(import.meta.dirname, "..");

function judge(env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "judge-test-"));
  const { META_MODEL_API_KEY: _key, MANO_MODEL_BASE_URL: _base, ...rest } = process.env;
  const child = spawn(join(QUALITY, "node_modules", ".bin", "tsx"), ["src/bin/judge.ts", "--out", dir], { cwd: QUALITY, env: { ...rest, ...env } });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out, dir })));
}

test("with no key every step finishes, model steps say they used recordings, and the filing lands", async () => {
  const { code, out, dir } = await judge({});
  assert.equal(code, 0, out);
  assert.match(out, /No META_MODEL_API_KEY is set/);
  assert.match(out, /simulated {2}Segments the photo into pages: recorded response; no META_MODEL_API_KEY is set \[SAM 3\.1 \(sam-3\.1\)\]/);
  assert.match(out, /simulated {2}Reads the page into cited fields: recorded response; no META_MODEL_API_KEY is set \[Muse Spark 1\.3/);
  assert.match(out, /Mano: This is a SNAP renewal letter\. It is due November 14, 2026\./);
  assert.match(out, /Gateway: completed, confirmation SR-/);
  assert.match(out, /Portal lookup: received, SR-/);
  assert.match(out, /Finished 9 of 9 steps/);
  for (let i = 1; i <= 9; i++) assert.match(out, new RegExp(`^\\[${i}/9\\] `, "m"));
  assert.ok(existsSync(join(dir, "letter.jpg")));
  assert.match(readFileSync(join(dir, "replay.html"), "utf8"), /Mano filled in &quot;Monthly income \(\$\)&quot;/);
});

test("a 402 from the model API prints why, falls back to the recordings and exits 1", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    req.resume();
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "billing_error", code: "payment_required" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const { code, out } = await judge({ META_MODEL_API_KEY: "test-key", MANO_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1` });
    assert.equal(code, 1, out);
    assert.equal(calls, 2);
    assert.match(out, /! The live SAM 3\.1 call failed: Model request failed: 402 \(billing is not set up for this account\)\. This step used its recorded response\./);
    assert.match(out, /! The live Muse Spark 1\.3 call failed: Model request failed: 402/);
    assert.match(out, /Finished 9 of 9 steps/);
    assert.match(out, /Result: FAILED/);
    assert.doesNotMatch(out, /test-key/);
  } finally {
    server.close();
  }
});
