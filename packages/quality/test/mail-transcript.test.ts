// The letters' transcript stage on a fake OpenRouter: the real mail reader runs
// from the letter's text, SAM 3.1 never leaves the machine, no image is sent,
// every request carries the zero-retention pin, and reports name what was
// skipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSCRIPT_STAGE_DETAIL, TranscriptDeadlineModelReader, TranscriptMailPath } from "../src/mail-transcript.ts";
import { expectedDeadline, loadDeadlineReader, scoreMailDeadlines } from "../src/mail.ts";
import { loadPaths } from "../src/paths.ts";
import { FakeJudge } from "../src/judge.ts";
import { runBench } from "../src/run.ts";
import { extractDates } from "../src/checks.ts";
import { buildLettersCases } from "../src/suites/letters.ts";

const SWITCH = { MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test-key-not-used" };

const nil = { text: null, box_2d: null };
const field = (text: string | null) => (text ? { text, box_2d: [0, 0, 1000, 1000] } : nil);

// A model that reads the note it is given: it copies the transcript and cites
// each sentence holding a date as a deadline.
function pageReply(prompt: string): string {
  const transcript = prompt.split("\n\n").slice(2).join("\n\n");
  const sentences = transcript.split(/\n|(?<=\.)\s+/).filter((s) => extractDates(s).length > 0 && /\b(by|due)\b/i.test(s));
  return JSON.stringify({
    readable: true,
    readability_note: null,
    full_text: transcript,
    sender: field(transcript.split("\n")[0] ?? null),
    program: nil,
    subject: nil,
    asked: [],
    deadlines: sentences.map(field),
    consequence: nil,
    reference_no: nil,
    notice_date: nil,
    phones: [],
    links: [],
    addresses: [],
    page_marker: nil,
    extra_letter: null,
  });
}

function fakeOpenRouter() {
  const bodies: { model: string; provider: unknown; messages: { role: string; content: string }[]; response_format?: unknown }[] = [];
  const urls: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
    bodies.push(body);
    const prompt = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    return Response.json({ choices: [{ message: { content: pageReply(prompt) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies, urls };
}

const letters = buildLettersCases();
const oneDate = letters.find((c) => expectedDeadline(c) !== null)!;

test("a letter is read from its text, with SAM skipped and no image sent", async () => {
  const fake = fakeOpenRouter();
  const answer = await new TranscriptMailPath("k", fake.fetchFn).answer(oneDate);
  assert.ok(fake.bodies.length >= 1);
  assert.ok(fake.urls.every((u) => u.startsWith("https://openrouter.ai/")));
  for (const body of fake.bodies) {
    assert.equal(body.model, "meta/muse-spark-open");
    assert.deepEqual(body.provider, { zdr: true, data_collection: "deny" });
    assert.ok(body.response_format, "the page schema goes with the request");
    assert.ok(body.messages.every((m) => !m.content.includes("data:image")));
    assert.ok(!JSON.stringify(body).includes("sam-3.1"));
  }
  assert.ok(answer.text.length > 0);
  assert.ok(answer.inputTokens > 0);
});

test("the real gate decides what the model read", async () => {
  const fake = fakeOpenRouter();
  const answer = await new TranscriptMailPath("k", fake.fetchFn).answer(oneDate);
  const held = answer.actions.filter((a) => a.kind === "deadline");
  assert.equal(held.length, 1, "a plain one-date letter holds its deadline");
  const reader = new TranscriptDeadlineModelReader("k", fake.fetchFn);
  assert.equal(await reader.readDeadline(oneDate.input.images![0]!), expectedDeadline(oneDate));
});

test("a case without exactly one letter is an error, not a guess", async () => {
  const fake = fakeOpenRouter();
  await assert.rejects(new TranscriptMailPath("k", fake.fetchFn).answer({ ...oneDate, input: { ...oneDate.input, images: [] } }), /one letter per case/);
  assert.equal(fake.bodies.length, 0);
});

test("with the switch on the letters take this path and name what was skipped", async () => {
  const loaded = (await loadPaths({ ...SWITCH, META_MODEL_API_KEY: "other" })).forCase(oneDate);
  assert.equal(loaded.path.name, "mail-transcript-stage");
  assert.match(loaded.detail, /SAM 3\.1 and the page vision read were skipped/);
  const reader = await loadDeadlineReader(SWITCH);
  assert.equal(reader.reader.name, "mail-transcript-stage");
  assert.equal(reader.detail, TRANSCRIPT_STAGE_DETAIL);
  assert.equal((await loadPaths(SWITCH)).textLineModel, "meta/muse-spark-open");
});

test("the deadline score runs over the letters on this path", async () => {
  const fake = fakeOpenRouter();
  const summary = await scoreMailDeadlines(new TranscriptDeadlineModelReader("k", fake.fetchFn), TRANSCRIPT_STAGE_DETAIL);
  assert.equal(summary.letters, letters.length);
  assert.equal(summary.correct + summary.misses.length, letters.length);
  assert.equal(summary.detail, TRANSCRIPT_STAGE_DETAIL);
});

test("the bench runs the letters suite end to end on this path", async () => {
  const fake = fakeOpenRouter();
  const path = new TranscriptMailPath("k", fake.fetchFn);
  const { report, results, paths } = await runBench({
    suites: ["letters"],
    env: {},
    judge: new FakeJudge(),
    skipCalibration: true,
    pathSet: { forCase: () => ({ path, standin: false, detail: TRANSCRIPT_STAGE_DETAIL }), textLineModel: "meta/muse-spark-open" },
  });
  assert.equal(results.length, letters.length);
  assert.equal(report.suites.letters!.liveCases, letters.length);
  assert.equal(report.suites.letters!.version, 2);
  assert.equal(paths.letters!.detail, TRANSCRIPT_STAGE_DETAIL);
  assert.ok(results.every((r) => r.path?.name === "mail-transcript-stage"));
  assert.ok(results.every((r) => !r.checks.some((c) => c.id === "answer-error")));
});
