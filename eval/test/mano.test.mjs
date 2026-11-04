// Mano and the OpenRouter route under the harness, with no keys: the broker's
// pin, the general agent's tool loop on chat completions, the mapping from a
// reading to the eval's shape, and Mano's real reader in the sandboxed child.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { generalAgentBaseline } from "../src/baselines.mjs";
import { buildMano, manoBundleHash } from "../src/build-mano.mjs";
import { gradeAll } from "../src/grader.mjs";
import { osSandboxAvailable, osSandboxProfile, runSystem } from "../src/harness.mjs";
import { readRecord, verifyMano } from "../src/verify.mjs";
import { OPEN_WEIGHT_MODEL, modelRoute, pinnedChatBody, preflight, toChatMessages, ZERO_RETENTION, MODAL_MODEL, modalCeilingUsd, modalChatBody, modalReserveUsd, modalSpendReport } from "../src/openrouter.mjs";

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
const { brokeredModelClient, letterResult, manoHousehold, splitNames } = await import(join(bundleDir, "adapter.mjs"));

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
  const body = pinnedChatBody({ model: "other/model", models: ["other/model"], route: "fallback", plugins: [], messages: [], provider: { zdr: false, data_collection: "allow", sort: "latency", order: ["x"], only: ["x"] } });
  assert.equal(body.model, OPEN_WEIGHT_MODEL);
  assert.deepEqual(body.provider, { sort: "latency", ...ZERO_RETENTION });
  assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "provider", "usage"]);
});

test("preflight stops a run on a refused call", async () => {
  const seen = [];
  const refused = await preflight("openrouter", { env: { OPENROUTER_API_KEY: "x" }, fetchImpl: async (_u, o) => { seen.push(JSON.parse(o.body)); return jsonResponse({}, 402); } });
  assert.deepEqual(refused, { ok: false, status: 402 });
  const errorBody = await preflight("openrouter", { env: { OPENROUTER_API_KEY: "x" }, fetchImpl: async () => jsonResponse({ error: { code: 402 } }) });
  assert.equal(errorBody.ok, false, "status 200 with an error body is not a usable answer");
  const answered = await preflight("openrouter", { env: { OPENROUTER_API_KEY: "x" }, fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }) });
  assert.equal(answered.ok, true);
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

test("a question that names no date earns no reminder", async () => {
  const q = confirm("2026-11-25");
  q.proposal.confidence = "low";
  q.proposal.others = [{ sentence: "Or return it by December 1, 2026.", dates: ["2026-12-01"], citation: null }];
  const r = await letterResult(letter, reading({ questions: [q] }), { client: noModel, fetchImpl: noNet, hasDocuments: [] });
  assert.equal(r.reminder, null);
});

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
  const unread = reading({ questions: [{ id: "Q1", kind: "unreadable_page", letterId: "L1", prompt: "", citation: null }] });
  unread.letters[0].fields.excerpt = "";
  assert.equal(await score(unread), 1, "nothing was read, so the answer asks for the page again");
  assert.equal(await score(reading({ questions: [{ id: "Q1", kind: "read_failed", letterId: null, prompt: "", citation: null }] })), 0);
  assert.equal(await score(reading({ questions: [{ id: "Q1", kind: "missing_page", letterId: "L1", prompt: "", citation: null }] })), 0, "the answer asks for nothing here");
});

const emptyPacketKey = { "hh-900": { letters: { "hh-900-L1": { hardCase: null } }, groundTruth: { deadlines: [], correctPacket: [], packetGroups: [], mustRefuse: [], mustRequest: [], decoyLetterIds: [] } } };
const fakeSharp = () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from("x") }) });

test("a failed read earns no packet credit, even for an empty packet", async () => {
  const out = await manoHousehold(HOUSEHOLD, { route: "openrouter", fetchImpl: noNet, sharp: fakeSharp, read: async () => { throw new Error("boom"); } });
  assert.equal(out.packetIncomplete, true);
  assert.equal(gradeAll([out], emptyPacketKey).correctPackets, 0);
  const clean = { householdId: "hh-900", status: "ok", reminders: [], packet: [], refused: [], enforced: [], requested: [], failures: [], toolCalls: [] };
  assert.equal(gradeAll([clean], emptyPacketKey).correctPackets, 1, "a clean empty packet still earns it");
});

test("a failed name mapping keeps the date and leaves the packet incomplete", async () => {
  const asked = reading({ questions: [confirm("2026-11-25")] });
  asked.letters[0].fields.asked = [{ value: "Send your pay stub.", citation: null }];
  const badNames = { responses: async () => ({ text: "not json" }) };
  const r = await letterResult(letter, asked, { client: badNames, fetchImpl: noNet, hasDocuments: [] });
  assert.equal(r.namesFailed, true);
  assert.deepEqual(r.reminder, { letterId: "hh-900-L1", dueDate: "2026-11-25" });
});

test("a broker transport failure reaches Mail's client as one it retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-retry-"));
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const answer = new Promise((resolve) => process.on("message", (m) => { if (m && m.id === 1) resolve(m); }));
process.send({ channel: "mano-eval-broker", id: 1, url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", headers: {}, body: "{}" });
const m = await answer;
await writeFile(out, JSON.stringify([{ householdId: "hh-900", transport: m.transport, error: m.error }]));
`);
  try {
    const { outputs } = await withOpenRouterEnv(() => runSystem(probe, [HOUSEHOLD], { broker: true, fetchImpl: async () => { throw new Error("secret text from the provider"); } }));
    assert.equal(outputs[0].transport, true);
    assert.equal(outputs[0].error, "broker fetch failed", "the provider's words never cross");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a page Mano says nothing about is still a failure", async () => {
  const r = await letterResult(letter, reading({ questions: [{ id: "Q1", kind: "missing_page", letterId: "L1", prompt: "", citation: null }] }), { client: noModel, fetchImpl: noNet, hasDocuments: [] });
  assert.equal(r.failure.reason, "page_not_read_and_not_asked");
});

test("a date from a candidate counts when the answer shows it", async () => {
  const q = { id: "Q1", kind: "confirm_deadline", letterId: "L1", prompt: "", citation: null, candidates: [{ sentence: "Return it by November 25, 2026.", dates: ["2026-11-25"], citation: null }] };
  const r = await letterResult(letter, reading({ questions: [q] }), { client: noModel, fetchImpl: noNet, hasDocuments: [] });
  assert.deepEqual(r.reminder, { letterId: "hh-900-L1", dueDate: "2026-11-25" });
});

test("Mail's client keeps the reader's deadline and goes through the broker", async () => {
  const seen = [];
  const meter = { used: [], add(u) { this.used.push(u); } };
  const client = brokeredModelClient({ route: "meta", meter, fetchImpl: async (u, o) => { seen.push({ u: String(u), o }); return jsonResponse({ output_text: "x", usage: { input_tokens: 1, output_tokens: 1 } }); } });
  await assert.rejects(client.responses({ model: "muse-spark-1.3-contributor", input: "x" }, { deadline: Date.now() - 1 }));
  assert.equal(seen.length, 0, "an expired deadline makes no call");
  await client.responses({ model: "muse-spark-1.3-contributor", input: "x" }, { deadline: Date.now() + 60000 });
  assert.match(seen[0].u, /api\.meta\.ai/);
  assert.ok(seen[0].o.signal, "the client's timeout can stop the call");
  assert.equal(meter.used.length, 1, "usage is counted");
});

test("a cancel from the child stops the parent's request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-cancel-"));
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const answer = new Promise((resolve) => process.on("message", (m) => { if (m && m.id === 1) resolve(m); }));
process.send({ channel: "mano-eval-broker", id: 1, url: "https://openrouter.ai/api/v1/chat/completions", method: "POST", headers: {}, body: "{}" });
setTimeout(() => process.send({ channel: "mano-eval-broker", cancel: 1 }), 100);
const m = await answer;
await writeFile(out, JSON.stringify([{ householdId: "hh-900", ok: m.ok }]));
`);
  let aborted = false;
  const fetchImpl = (_u, o) => new Promise((_resolve, reject) => o.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
  try {
    const { outputs } = await withOpenRouterEnv(() => runSystem(probe, [HOUSEHOLD], { broker: true, fetchImpl }));
    assert.equal(aborted, true);
    assert.equal(outputs[0].ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tsconfig cannot change what Mano's bundle runs", async () => {
  const path = new URL("../tsconfig.json", import.meta.url).pathname;
  const before = await manoBundleHash();
  await writeFile(path, JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@mano/mail": ["./src/pool.mjs"] } } }));
  try {
    assert.equal(await manoBundleHash(), before);
  } finally {
    await rm(path, { force: true });
  }
});

test("duplicates earn nothing, and an invalid result keeps its cut-off deadline", () => {
  const key = (hardCase) => ({ "hh-900": { letters: { "hh-900-L1": { hardCase } }, groundTruth: { deadlines: [{ letterId: "hh-900-L1", dueDate: "2026-11-25" }], correctPacket: [], packetGroups: [], mustRefuse: [], mustRequest: [], decoyLetterIds: [] } } });
  const ok = { householdId: "hh-900", status: "ok", reminders: [{ letterId: "hh-900-L1", dueDate: "2026-11-25" }], packet: [], refused: [], enforced: [], requested: [], failures: [], toolCalls: [] };
  const twice = gradeAll([ok, ok], key(null));
  assert.equal(twice.correctPackets, 0);
  assert.equal(twice.missedDeadlines, 1);
  const invalid = gradeAll([{ ...ok, status: "invalid", reminders: [], failures: [{ letterId: "hh-900-L1", reason: "please send a readable copy" }] }], key("cutoff"));
  assert.equal(invalid.deadlinesTotal, 1);
  assert.equal(invalid.missedDeadlines, 1);
});

test("the freeze pins Mano's reader and catches a change", async () => {
  const record = await readRecord();
  assert.ok(record.mano["packages/mail/src/gate.ts"], "the reader's source is pinned");
  assert.ok(record.mano["pnpm-lock.yaml"], "the locked dependencies are pinned");
  assert.ok(record.mano.bundle, "the built bundle is pinned");
  const changed = { ...record, mano: { ...record.mano, "packages/mail/src/gate.ts": "0".repeat(64) } };
  assert.ok((await verifyMano(changed)).mismatches.includes("packages/mail/src/gate.ts"));
});

test("an interrupted run removes its temp dir and exits", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-interrupt-")));
  const cleanup = new URL("../src/cleanup.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const { registerTemp } = await import(${JSON.stringify(cleanup)}); registerTemp(${JSON.stringify(dir)}); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.equal(existsSync(dir), false);
});

test("the OS sandbox stops what Node's permission model cannot", { skip: osSandboxAvailable() ? false : "macOS only" }, async () => {
  const answers = new URL("../data/dev-answers.json", import.meta.url).pathname;
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mano-eval-os-")));
  const profile = osSandboxProfile(dir);
  // Outside the home and session temp folders, like a pack someone put elsewhere.
  const outside = join(await realpath("/private/var/tmp"), `mano-eval-fake-pack-${process.pid}.json`);
  await writeFile(outside, "{}");
  const server = createServer((_q, a) => a.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const inside = (cmd, ...args) => new Promise((resolve) => {
    const p = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", cmd, ...args], { stdio: "pipe" });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(out));
  });
  try {
    assert.equal(spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/cat", answers]).status, 0, "the file exists and is readable outside");
    assert.match(await inside(`try { require("fs").readFileSync(${JSON.stringify(answers)}); console.log("READ"); } catch (e) { console.log(e.code); }`), /EPERM/);
    assert.match(await inside(`fetch(${JSON.stringify(url)}).then(() => console.log("REACHED"), () => console.log("DENIED"));`), /DENIED/);
    assert.match(await inside(`try { require("child_process").execFileSync("/bin/echo", ["RAN"], { stdio: "pipe" }); console.log("RAN"); } catch { console.log("DENIED"); }`), /DENIED/);
    assert.match(await inside(`try { require("fs").writeFileSync(${JSON.stringify(answers + ".probe")}, "x"); console.log("WROTE"); } catch (e) { console.log(e.code); }`), /EPERM/);
    assert.equal(existsSync(answers + ".probe"), false);
    assert.match(await inside(`try { require("fs").readFileSync(${JSON.stringify(outside)}); console.log("READ"); } catch (e) { console.log(e.code); }`), /EPERM/, "a file outside home and temp is denied too");
    assert.match(await inside(`console.log(require("fs").readdirSync("/System/Library/Fonts").length > 0 ? "FONTS" : "NONE");`), /FONTS/);
    assert.match(await inside(`require("fs").writeFileSync(${JSON.stringify(join(dir, "ok"))}, "x"); console.log("WROTE");`), /WROTE/);
  } finally {
    server.close();
    await rm(outside, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
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
const good = await ask(1, JSON.stringify({ models: ["other/model"], route: "fallback", provider: { zdr: false, data_collection: "allow" }, messages: [] }));
const bad = await ask(2, JSON.stringify({ model: "other/model", messages: [] }));
await writeFile(out, JSON.stringify([{ householdId: "hh-900", good: good.ok, bad: bad.ok, why: bad.error }]));
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
    assert.equal(sent.models, undefined);
    assert.equal(sent.route, undefined);
    assert.ok(seen[0].signal, "the request can be stopped");
    assert.match(seen[0].headers.authorization, /^Bearer /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const MODAL_ENV = { MODAL_ENDPOINT_URL: "https://ep-test.us-west.modal.direct", MODAL_PROXY_TOKEN: "x", MANO_EVAL_CEILING_USD: "100" };
const modalAnswer = () => jsonResponse({ model: MODAL_MODEL, choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });

test("a Modal ceiling that is missing, zero or invalid refuses instead of meaning unlimited", async () => {
  assert.equal(modalCeilingUsd({ MANO_EVAL_CEILING_USD: "45" }), 45);
  for (const bad of [undefined, "", " ", "0", "-1", "abc", "Infinity", "NaN"]) {
    assert.equal(modalCeilingUsd({ MANO_EVAL_CEILING_USD: bad }), null, String(bad));
    let called = 0;
    const r = await preflight("modal", { env: { ...MODAL_ENV, MANO_EVAL_CEILING_USD: bad }, fetchImpl: async () => { called++; return modalAnswer(); } });
    assert.equal(r.ok, false, String(bad));
    assert.equal(called, 0, "nothing reaches the network");
  }
});

test("the Modal preflight goes through the meter", async () => {
  const before = modalSpendReport(MODAL_ENV);
  const r = await preflight("modal", { env: MODAL_ENV, fetchImpl: async () => modalAnswer() });
  assert.equal(r.ok, true);
  const after = modalSpendReport(MODAL_ENV);
  assert.equal(after.calls, before.calls + 1);
  assert.equal(after.promptTokens, before.promptTokens + 10);
  assert.ok(after.spentUsd >= before.spentUsd);
  assert.equal(after.reservedUsd, 0);
  await preflight("modal", { env: MODAL_ENV, fetchImpl: async () => { throw new Error("down"); } });
  assert.ok(modalSpendReport(MODAL_ENV).spentUsd > after.spentUsd, "a call that failed in transport stays charged");
  assert.equal(modalSpendReport(MODAL_ENV).reservedUsd, 0);
});

test("a Modal reservation grows with the request and always has a token limit", () => {
  const small = modalChatBody({ messages: [{ role: "user", content: "hi" }], max_tokens: 100 });
  const large = modalChatBody({ messages: [{ role: "user", content: "x".repeat(120000) }], max_tokens: 100 });
  assert.ok(modalReserveUsd(large) >= 30000 * 1.25e-6, "covers 30k prompt tokens");
  assert.ok(modalReserveUsd(small) < modalReserveUsd(large));
  for (const bad of [undefined, "8000", 0, -5, 1.5, null]) {
    const body = modalChatBody({ messages: [], max_tokens: bad });
    assert.equal(body.max_tokens, 8000, String(bad));
    assert.ok(Number.isFinite(modalReserveUsd(body)));
  }
});

test("a call over the Modal ceiling never reaches the network and stops the run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-ceiling-"));
  const script = join(dir, "over.mjs");
  await writeFile(script, `import { admitModalCall, modalChatBody } from ${JSON.stringify(new URL("../src/openrouter.mjs", import.meta.url).href)};
const big = modalChatBody({ messages: [{ role: "user", content: "x".repeat(120000) }], max_tokens: 100 });
process.on("exit", () => console.log("exiting"));
const reserve = admitModalCall(big);
console.log("admitted " + (reserve !== null));
setTimeout(() => {}, 5000);
`);
  try {
    const run = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, MANO_EVAL_CEILING_USD: "0.03" }, encoding: "utf8", timeout: 20000 });
    assert.match(run.stderr, /CEILING: stopping the run/);
    assert.equal(run.signal, "SIGTERM", "the process stops itself");
    assert.doesNotMatch(run.stdout, /admitted true/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the broker refuses Modal calls under a zero ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-zero-"));
  const probe = join(dir, "probe.mjs");
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const on = async (m) => {
  if (m && m.id === 1) await writeFile(out, JSON.stringify([{ householdId: "hh-900", ok: m.ok, why: m.error }]));
  if (m && m.id === 1) process.disconnect();
};
process.on("message", on);
process.send({ channel: "mano-eval-broker", id: 1, url: "https://ep-test.us-west.modal.direct/v1/chat/completions", method: "POST", headers: {}, body: JSON.stringify({ messages: [] }) });
`);
  const saved = { ...process.env };
  Object.assign(process.env, MODAL_ENV, { MANO_MODEL_PROVIDER: "modal", MANO_EVAL_CEILING_USD: "0" });
  let called = 0;
  try {
    const { outputs } = await runSystem(probe, [HOUSEHOLD], { broker: true, fetchImpl: async () => { called++; return modalAnswer(); } });
    assert.equal(outputs[0].ok, false);
    assert.match(outputs[0].why, /spending ceiling/);
    assert.equal(called, 0);
  } finally {
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the broker sends Modal calls with its token and model, and prices them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-modal-"));
  const probe = join(dir, "probe.mjs");
  const chat = "https://ep-test.us-west.modal.direct/v1/chat/completions";
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const ask = (id, url, body) => new Promise((resolve) => {
  const on = (m) => { if (m && m.id === id) { process.off("message", on); resolve(m); } };
  process.on("message", on);
  process.send({ channel: "mano-eval-broker", id, url, method: "POST", headers: {}, body });
});
const good = await ask(1, "${chat}", JSON.stringify({ provider: { zdr: true }, usage: { include: true }, reasoning: { exclude: true }, messages: [], max_tokens: 100 }));
const other = await ask(2, "${chat}", JSON.stringify({ model: "other/model", messages: [] }));
const router = await ask(3, "https://openrouter.ai/api/v1/chat/completions", JSON.stringify({ messages: [] }));
const liar = await ask(4, "${chat}", JSON.stringify({ messages: [], max_tokens: 100 }));
await writeFile(out, JSON.stringify([{ householdId: "hh-900", good: good.ok, cost: good.json?.usage?.cost, other: other.ok, router: router.ok, liar: liar.ok }]));
`);
  const seen = [];
  const saved = { ...process.env };
  Object.assign(process.env, { MANO_MODEL_PROVIDER: "modal", MODAL_ENDPOINT_URL: "https://ep-test.us-west.modal.direct", MODAL_PROXY_TOKEN: "test-modal-token", MANO_EVAL_CEILING_USD: "100" });
  try {
    let n = 0;
    const { outputs } = await runSystem(probe, [HOUSEHOLD], { broker: true, fetchImpl: async (u, o) => {
      seen.push({ url: u, ...o });
      n++;
      return jsonResponse({ model: n === 1 ? MODAL_MODEL : "other/model", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } });
    } });
    assert.equal(outputs[0].good, true);
    assert.equal(outputs[0].cost, 1000 * 1.25e-6 + 500 * 4.25e-6);
    assert.equal(outputs[0].other, false, "another model is refused");
    assert.equal(outputs[0].router, false, "the other route is refused");
    assert.equal(outputs[0].liar, false, "an answer from another model is refused");
    assert.equal(seen.length, 2, "refused calls never reach the network");
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.model, MODAL_MODEL);
    for (const k of ["provider", "usage", "reasoning"]) assert.equal(sent[k], undefined, k);
    assert.equal(seen[0].headers.authorization, "Bearer test-modal-token");
  } finally {
    process.env = saved;
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
    return jsonResponse({ model: OPEN_WEIGHT_MODEL, usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 }, choices: [{ finish_reason: "stop", message: { content } }] });
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

test("native code in the Mano child cannot read outside the run dir", { skip: osSandboxAvailable() ? false : "macOS only" }, async () => {
  const built = await buildMano();
  const dir = await mkdtemp(join(tmpdir(), "mano-eval-addon-"));
  const probe = join(dir, "probe.mjs");
  const photo = new URL("../data/photos/hh-013-L2.jpg", import.meta.url).pathname;
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const { default: sharp } = await import("sharp");
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const staged = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer();
let verdict = "READ";
try { await sharp(${JSON.stringify(photo)}).metadata(); } catch { verdict = "DENIED"; }
await writeFile(out, JSON.stringify([{ householdId: "hh-900", verdict, sharpWorks: staged.length > 0 }]));
`);
  try {
    const { outputs } = await runSystem(probe, [HOUSEHOLD], { sandbox: built.sandbox });
    assert.equal(outputs[0].sharpWorks, true, "sharp itself still works");
    assert.equal(outputs[0].verdict, "DENIED", "the file sharp can read without the OS sandbox stays out of reach");
  } finally {
    await built.cleanup();
    await rm(dir, { recursive: true, force: true });
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
