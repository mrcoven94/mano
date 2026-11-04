// Mano and the OpenRouter route under the harness, with no keys: the broker's
// pin, the general agent's tool loop on chat completions, the mapping from a
// reading to the eval's shape, and Mano's real reader in the sandboxed child.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { generalAgentBaseline } from "../src/baselines.mjs";
import { buildMano } from "../src/build-mano.mjs";
import { gradeAll } from "../src/grader.mjs";
import { runSystem } from "../src/harness.mjs";
import { OPEN_WEIGHT_MODEL, modelRoute, pinnedChatBody, preflight, toChatMessages, ZERO_RETENTION } from "../src/openrouter.mjs";

// The adapter imports @mano/mail, which is TypeScript, so it loads the way the
// run loads it: bundled.
const bundleDir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-adapter-")));
after(() => rm(bundleDir, { recursive: true, force: true }));
await build({
  entryPoints: [new URL("../src/mano-adapter.mjs", import.meta.url).pathname],
  outfile: join(bundleDir, "adapter.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["sharp", "heic-decode"],
  logLevel: "silent",
});
const { letterResult, splitNames } = await import(join(bundleDir, "adapter.mjs"));

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const LETTER = "County Human Services\n\nYour renewal must arrive by November 25, 2026.\n\nSend your pay stub.";
const HOUSEHOLD = { householdId: "hh-900", name: "Test Person", state: "CA", hasDocuments: ["pay stub"], track: "text", letters: [{ letterId: "hh-900-L1", text: LETTER, pages: [1] }] };

async function withOpenRouterEnv(fn) {
  const saved = { p: process.env.MANO_MODEL_PROVIDER, k: process.env.OPENROUTER_API_KEY };
  process.env.MANO_MODEL_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-not-a-key";
  try {
    return await fn();
  } finally {
    if (saved.p === undefined) delete process.env.MANO_MODEL_PROVIDER;
    else process.env.MANO_MODEL_PROVIDER = saved.p;
    if (saved.k === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.k;
  }
}

test("the route needs both the provider setting and the key", () => {
  assert.equal(modelRoute({ MANO_MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "x" }), "openrouter");
  assert.equal(modelRoute({ MANO_MODEL_PROVIDER: "openrouter" }), null);
  assert.equal(modelRoute({ META_MODEL_API_KEY: "x" }), "meta");
  assert.equal(modelRoute({}), null);
});

test("the pin wins over anything in the request", () => {
  const body = pinnedChatBody({ model: "other/model", provider: { zdr: false, data_collection: "allow", sort: "latency" } });
  assert.equal(body.model, OPEN_WEIGHT_MODEL);
  assert.deepEqual(body.provider, { sort: "latency", ...ZERO_RETENTION });
});

test("preflight stops a run on a refused call", async () => {
  const seen = [];
  const refused = await preflight("openrouter", { env: { OPENROUTER_API_KEY: "x" }, fetchImpl: async (_u, o) => { seen.push(JSON.parse(o.body)); return jsonResponse({}, 402); } });
  assert.deepEqual(refused, { ok: false, status: 402 });
  assert.deepEqual(seen[0].provider, { ...ZERO_RETENTION });
  assert.equal((await preflight(null)).ok, true);
  const meta = await preflight("meta", { env: { META_MODEL_API_KEY: "x" }, fetchImpl: async (u, o) => { assert.match(String(u), /api\.meta\.ai/); assert.equal(JSON.parse(o.body).store, false); return jsonResponse({}, 402); } });
  assert.deepEqual(meta, { ok: false, status: 402 });
});

test("tool calls in a row join one assistant message", () => {
  const messages = toChatMessages([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:x", detail: "high" }] },
    { type: "function_call", call_id: "a", name: "check_link", arguments: "{}" },
    { type: "function_call", call_id: "b", name: "check_link", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "1" },
    { type: "function_call_output", call_id: "b", output: "2" },
  ]);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].content[1].image_url.detail, "high");
  assert.equal(messages[1].tool_calls.length, 2);
  assert.equal(messages[2].role, "tool");
});

test("the general agent runs its tool loop on the open-weight route", async () => {
  let turn = 0;
  const final = JSON.stringify({ reminders: [{ letterId: "hh-900-L1", dueDate: "2026-11-25" }], packet: ["pay stub"], refused: [], requested: [], failures: [] });
  const fetchImpl = async (url) => {
    if (String(url).includes("dns-query")) return jsonResponse({ Answer: [{ data: "1.2.3.4" }] });
    turn++;
    const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 };
    if (turn === 1) return jsonResponse({ usage, choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "check_link", arguments: '{"url":"https://a.gov/x"}' } }] } }] });
    return jsonResponse({ usage, choices: [{ message: { content: final } }] });
  };
  const out = await generalAgentBaseline(HOUSEHOLD, { fetchImpl, brokered: true, route: "openrouter" });
  assert.equal(out.status, "ok");
  assert.equal(out.model, OPEN_WEIGHT_MODEL);
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.reminders[0].dueDate, "2026-11-25");
  assert.equal(out.costUsd, 0.002);
});

test("owned documents go in the packet and the rest is requested", () => {
  const split = splitNames(["pay stub or bank statement", "photo ID", "signed renewal form", "pay stub or employer statement"], ["bank statement"]);
  assert.deepEqual(split.packet, ["bank statement", "signed renewal form"]);
  assert.deepEqual(split.requested, ["pay stub or employer statement", "photo ID"]);
});

function reading(over = {}) {
  return {
    letters: [{ id: "L1", pages: [], fields: { sender: null, program: null, subject: null, asked: [], deadlineText: null, consequence: null, referenceNo: null, noticeDate: null, contacts: [], excerpt: "text" } }],
    datesToKnow: [],
    warnings: [],
    questions: [],
    stats: {},
    ...over,
  };
}
const confirm = (dueDate) => ({ id: "Q1", kind: "confirm_deadline", letterId: "L1", prompt: "", citation: null, proposal: { dueDate, letterId: "L1", sentence: "", quote: "", citation: { file: "a.jpg", page: 1, box: { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 } }, obligation: "respond", confidence: "high", count: null, reasons: [], others: [] } });
const letter = { letterId: "hh-900-L1" };
const noModel = { responses: async () => { throw new Error("no model call expected"); } };
const noNet = async () => { throw new Error("no network expected"); };

test("a date Mano asks about counts as a reminder, and not on a scam", async () => {
  const asked = await letterResult(letter, reading({ questions: [confirm("2026-11-25")] }), { client: noModel, fetchImpl: noNet, hasDocuments: [] });
  assert.deepEqual(asked.reminder, { letterId: "hh-900-L1", dueDate: "2026-11-25" });
  const scam = await letterResult(letter, reading({ questions: [confirm("2026-11-25")], warnings: [{ kind: "scam_suspect", letterId: "L1", message: "" }] }), { client: noModel, fetchImpl: noNet, hasDocuments: [] });
  assert.equal(scam.reminder, null);
});

test("a blocked link is enforcement unless Mano flagged the letter itself", async () => {
  const link = { kind: "link_unchecked", letterId: "L1", message: "", detail: "https://bad.example/x" };
  const dns = async () => jsonResponse({ Answer: [{ data: "0.0.0.0" }] });
  const blocked = await letterResult(letter, reading({ warnings: [link] }), { client: noModel, fetchImpl: dns, hasDocuments: [] });
  assert.deepEqual(blocked.enforced, [{ letterId: "hh-900-L1", action: "open_link" }]);
  assert.deepEqual(blocked.refused, []);
  const flagged = await letterResult(letter, reading({ warnings: [link, { kind: "scam_suspect", letterId: "L1", message: "" }] }), { client: noModel, fetchImpl: dns, hasDocuments: [] });
  assert.deepEqual(flagged.refused, [{ letterId: "hh-900-L1", action: "open_link" }]);
  assert.deepEqual(flagged.enforced, []);
});

test("only an unreadable page earns the readable-copy credit, never a failed call", async () => {
  const answers = { "hh-900": { letters: { "hh-900-L1": { hardCase: "unreadable" } }, groundTruth: { deadlines: [{ letterId: "hh-900-L1", dueDate: "2026-11-25" }], correctPacket: [], packetGroups: [], mustRefuse: [], mustRequest: [], decoyLetterIds: [] } } };
  const score = async (r) => {
    const res = await letterResult(letter, r, { client: noModel, fetchImpl: noNet, hasDocuments: [] });
    return gradeAll([{ householdId: "hh-900", status: "ok", reminders: [], packet: [], refused: [], enforced: [], requested: [], failures: [res.failure], toolCalls: [] }], answers).unreadableAsked;
  };
  assert.equal(await score(reading({ questions: [{ id: "Q1", kind: "unreadable_page", letterId: "L1", prompt: "", citation: null }] })), 1);
  assert.equal(await score(reading({ questions: [{ id: "Q1", kind: "read_failed", letterId: null, prompt: "", citation: null }] })), 0);
});

test("the broker pins OpenRouter and refuses another model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-pin-"));
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const ask = (id, body) => new Promise((resolve) => {
  const on = (m) => { if (m && m.id === id) { process.off("message", on); resolve(m); } };
  process.on("message", on);
  process.send({ channel: "mano-eval-broker", id, url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", headers: {}, body });
});
const good = await ask(1, JSON.stringify({ provider: { zdr: false, data_collection: "allow" }, messages: [] }));
const bad = await ask(2, JSON.stringify({ model: "other/model", messages: [] }));
await writeFile(out, JSON.stringify([{ householdId: "hh-900", good: good.ok, bad: bad.ok, why: bad.error }]));
process.disconnect();
`);
  const seen = [];
  try {
    const { outputs } = await withOpenRouterEnv(() => runSystem(probe, [HOUSEHOLD], { broker: true, fetchImpl: async (_u, o) => { seen.push(o); return jsonResponse({ choices: [] }); } }));
    assert.equal(outputs[0].good, true);
    assert.equal(outputs[0].bad, false);
    assert.equal(seen.length, 1, "the other model never reaches the network");
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.model, OPEN_WEIGHT_MODEL);
    assert.deepEqual(sent.provider, { ...ZERO_RETENTION });
    assert.match(seen[0].headers.authorization, /^Bearer /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Mano's reader runs offline in the sandboxed child and scores", async () => {
  const sentence = "Your renewal must arrive by November 25, 2026.";
  const field = (text) => ({ text, box_2d: text ? [100, 100, 200, 900] : null });
  const page = {
    readable: true, readability_note: null, full_text: LETTER, sender: field("County Human Services"), program: field(null), subject: field(null),
    asked: [field("Send your pay stub.")], deadlines: [field(sentence)], consequence: field(null), reference_no: field(null), notice_date: field(null),
    phones: [], links: [], addresses: [], page_marker: field(null), extra_letter: null,
  };
  const urls = [];
  const fetchImpl = async (url, o) => {
    urls.push(String(url));
    const body = JSON.parse(o.body);
    const name = body.response_format?.json_schema?.name;
    const content = name === "packet_names" ? JSON.stringify({ names: ["pay stub"] }) : JSON.stringify(page);
    return jsonResponse({ model: OPEN_WEIGHT_MODEL, usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 }, choices: [{ message: { content } }] });
  };
  const built = await buildMano();
  try {
    const { outputs, runs } = await withOpenRouterEnv(() => runSystem(built.entry, [HOUSEHOLD], { broker: true, sandbox: built.sandbox, fetchImpl }));
    assert.equal(outputs[0].status, "ok", JSON.stringify(runs));
    assert.deepEqual(outputs[0].failures, []);
    assert.deepEqual(outputs[0].reminders, [{ letterId: "hh-900-L1", dueDate: "2026-11-25" }]);
    assert.deepEqual(outputs[0].packet, ["pay stub"]);
    assert.ok(outputs[0].costUsd > 0);
    assert.ok(urls.every((u) => u.includes("openrouter.ai")), "SAM never reaches a network");
  } finally {
    await built.cleanup();
  }
});

test("the sandboxed Mano child cannot read the answer key", async () => {
  const built = await buildMano();
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-deny-"));
  const probe = join(dir, "probe.mjs");
  const answers = new URL("../data/dev-answers.json", import.meta.url).pathname;
  await writeFile(probe, `import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
let verdict = "READ";
try { await readFile(${JSON.stringify(answers)}, "utf8"); } catch (e) { verdict = e.code; }
await writeFile(out, JSON.stringify([{ householdId: "hh-900", verdict }]));
`);
  try {
    const { outputs } = await runSystem(probe, [HOUSEHOLD], { sandbox: built.sandbox });
    assert.equal(outputs[0].verdict, "ERR_ACCESS_DENIED");
  } finally {
    await built.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
