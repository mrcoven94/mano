// The judge command end to end, as a judge runs it: with no key; with a key
// whose model API answers 402 (billing not set up), which must say so on the
// model steps, finish on the recordings and exit 1; and with live answers
// that differ from the recorded ones, where no recording may stand in.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withoutJudgeLabels } from "../src/judge-replay.ts";

const QUALITY_DIR = import.meta.dirname;
const recorded = JSON.parse(readFileSync(join(QUALITY_DIR, "..", "src", "spine-replay.json"), "utf8")) as { segment: { answer: unknown }; read: { answer: unknown } };

const QUALITY = join(QUALITY_DIR, "..");

function judge(env: NodeJS.ProcessEnv, args: string[] = []): Promise<{ code: number | null; out: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "judge-test-"));
  const { META_MODEL_API_KEY: _key, MANO_MODEL_BASE_URL: _base, ...rest } = process.env;
  const child = spawn(join(QUALITY, "node_modules", ".bin", "tsx"), ["src/bin/judge.ts", "--out", dir, ...args], { cwd: QUALITY, env: { ...rest, ...env } });
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
  assert.match(out, /Case number: R-1042/);
  assert.match(out, /Mano asks Maria: Ready to send: Food benefits renewal \(to the State Benefits Renewal Office test portal\)\. Case number: R-1042;.*It ends with a declaration only you can make: I declare under penalty of perjury/);
  assert.match(out, /Filing before her answer: refused \(Only the applicant can make the renewal's declaration, and they have not answered it\.\); the portal has nothing/);
  assert.match(out, /Gateway: completed, confirmation SR-/);
  assert.match(out, /On file at the portal: case R-1042, declaration made by applicant/);
  assert.match(out, /Portal lookup: received, SR-/);
  assert.match(out, /Finished 9 of 9 steps/);
  for (let i = 1; i <= 9; i++) assert.match(out, new RegExp(`^\\[${i}/9\\] `, "m"));
  assert.ok(existsSync(join(dir, "letter.jpg")));
  const replay = readFileSync(join(dir, "replay.html"), "utf8");
  assert.match(replay, /Mano filled in &quot;Case number&quot;/);
  assert.match(replay, /<dt>Goes to<\/dt><dd>the State Benefits Renewal Office test portal<\/dd>/);
  assert.match(replay, /Judge run on synthetic data\./);
  assert.match(out, /simulated  Maria's text: the text line is not used; the photo kept in the repo is handed to Mano directly\n {6}real {7}Keeps the photo in Engine's in-memory document store/);
  for (const simulated of [
    "Maria&#39;s text: the text line is not used; the photo kept in the repo is handed to Mano directly.",
    "Texting Maria: the text line (iMessage and SMS) is not used; Mano&#39;s words are printed here.",
    "Mano&#39;s agent turn: not run;",
    "The deployed sandbox portal: the same portal code runs in this process on an in-memory store",
    "Engine as deployed (a Durable Object per person, its SQLite and encrypted R2 storage)",
    "Maria&#39;s private link: the replay page is saved as a file",
    "Segments the photo into pages: recorded response; no META_MODEL_API_KEY is set",
    "Reads the page into cited fields: recorded response; no META_MODEL_API_KEY is set",
    "Computer use: a stand-in.",
    "Guardian&#39;s verdict: recorded.",
    "Maria&#39;s YES: scripted, since Maria is synthetic.",
  ]) {
    assert.ok(replay.includes(`<li>${simulated}`), simulated);
  }
  assert.match(replay, /<p>You said yes to this version\.<\/p><div class="judge-label"><p><strong>Simulated: Maria is synthetic, and this run scripted her YES\./);
  assert.equal(replay.match(/Simulated: a screen drawn by the stand-in/g)?.length, 9);
  assert.doesNotMatch(withoutJudgeLabels(replay), /judge-label|Simulated|Judge run/);
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

test("the recorded reading never answers for another photo, even when SAM 3.1 boxes the same page", async () => {
  // The committed photo with one byte after its end: it still decodes, but
  // its bytes, and so its hash, are not the photo the reading was made for.
  const dir = mkdtempSync(join(tmpdir(), "judge-photo-"));
  const other = join(dir, "other-letter.jpg");
  writeFileSync(other, Buffer.concat([readFileSync(join(QUALITY, "src", "spine-letter.jpg")), Buffer.from([0])]));
  const sameBoxes = JSON.stringify(recorded.segment.answer);
  await withModelApi({ "sam-3.1": { status: 200, text: sameBoxes }, [READER]: { status: 402 } }, async (baseUrl) => {
    const { code, out } = await judge({ META_MODEL_API_KEY: "test-key", MANO_MODEL_BASE_URL: baseUrl }, ["--photo", other]);
    assert.equal(code, 1, out);
    assert.match(out, /real {7}Segments the photo into pages, live on Meta's API/);
    assert.match(out, /FAILED: the recorded reading was made for another photo/);
    assert.match(out, /\[not run\] Mano answers with the deadline/);
    assert.doesNotMatch(out, /November 14, 2026/);
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
