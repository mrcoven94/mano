// The judge command end to end, as a judge runs it: with no key; with a key
// whose model API answers 402 (billing not set up), which must say so on the
// model steps, finish on the recordings and exit 1; and with live answers
// that differ from the recorded ones, where no recording may stand in.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const QUALITY_DIR = import.meta.dirname;
const recorded = JSON.parse(readFileSync(join(QUALITY_DIR, "..", "src", "spine-replay.json"), "utf8")) as { read: { answer: unknown } };

const QUALITY = join(QUALITY_DIR, "..");

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

// A stand-in model API: each model ID gets a status and, on 200, a reply.
async function withModelApi(
  answers: Record<string, { status: number; text?: string }>,
  run: (baseUrl: string, calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      const model = (JSON.parse(body) as { model: string }).model;
      calls.push(model);
      const answer = answers[model] ?? { status: 500 };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(
        answer.status === 200
          ? JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: answer.text }] }], usage: { input_tokens: 1, output_tokens: 1 } })
          : JSON.stringify({ error: { type: "billing_error", code: "payment_required" } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls);
  } finally {
    server.close();
  }
}

const READER = "muse-spark-1.3-contributor";

test("a 402 from the model API prints why, falls back to the recordings and exits 1", async () => {
  await withModelApi({ "sam-3.1": { status: 402 }, [READER]: { status: 402 } }, async (baseUrl, calls) => {
    const { code, out } = await judge({ META_MODEL_API_KEY: "test-key", MANO_MODEL_BASE_URL: baseUrl });
    assert.equal(code, 1, out);
    assert.deepEqual(calls, ["sam-3.1", READER]);
    assert.match(out, /! The live SAM 3\.1 call failed: Model request failed: 402 \(billing is not set up for this account\)\. This step used its recorded response\./);
    assert.match(out, /! The live Muse Spark 1\.3 call failed: Model request failed: 402/);
    assert.match(out, /Finished 9 of 9 steps/);
    assert.match(out, /Result: FAILED/);
    assert.doesNotMatch(out, /test-key/);
  });
});

test("the recorded reading never answers for a page SAM 3.1 found somewhere else", async () => {
  // A live SAM 3.1 answer boxing a blank corner of the table, then a 402
  // from the reader: the recorded letter must not be read into that page.
  const corner = JSON.stringify({ detections: [{ box_2d: [0, 0, 60, 100], label: "letter", score: 0.9 }] });
  await withModelApi({ "sam-3.1": { status: 200, text: corner }, [READER]: { status: 402 } }, async (baseUrl) => {
    const { code, out } = await judge({ META_MODEL_API_KEY: "test-key", MANO_MODEL_BASE_URL: baseUrl });
    assert.equal(code, 1, out);
    assert.match(out, /real {7}Segments the photo into pages, live on Meta's API/);
    assert.match(out, /FAILED: the recorded reading was made for the page in SAM 3\.1's recorded answer, and the reader was given a different page/);
    assert.match(out, /\[not run\] Mano answers with the deadline/);
    assert.doesNotMatch(out, /November 14, 2026/);
    assert.doesNotMatch(out, /Finished 9 of 9/);
  });
});

test("Guardian's recorded pass never covers a different action", async () => {
  // A live reading of a letter whose deadline is November 21: the drafted
  // renewal cites another sentence, so Guardian's recorded verdict is not
  // for it and the action gets no verdict at all.
  const moved = JSON.stringify(recorded.read.answer).replaceAll("November 14", "November 21");
  await withModelApi({ "sam-3.1": { status: 402 }, [READER]: { status: 200, text: moved } }, async (baseUrl) => {
    const { code, out } = await judge({ META_MODEL_API_KEY: "test-key", MANO_MODEL_BASE_URL: baseUrl });
    assert.equal(code, 1, out);
    assert.match(out, /Deadline held: 2026-11-21/);
    assert.match(out, /Guardian's verdict: none, because no recording matches this action/);
    assert.match(out, /FAILED: Guardian has no recorded verdict for this action: its check request hashes to [0-9a-f]{12}, and the recording is for [0-9a-f]{12}/);
    assert.match(out, /\[not run\] Maria says yes and Mano files the renewal/);
    assert.doesNotMatch(out, /Gateway: completed/);
  });
});
