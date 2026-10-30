// Local proof that deadline nudges go out by themselves: a real Engine in
// wrangler dev, a real Durable Object alarm, and a recording stand-in for
// Channels' /internal/agent-send that checks each signature and dedupes on
// the key the way Channels does. No accounts, no keys: every value below
// is a local stand-in.
//
//   cd apps/engine && node --import ../../packages/quality/src/register.ts scripts/deadline-alarm.mjs
//
// 1. A deadline 12 days out is tracked; its first nudge is set for the
//    nudge time two minutes from now (MANO_NUDGE_TIME), and the alarm
//    delivers it with no call from this script.
// 2. A second person's nudge is handed to the stand-in, which records it
//    and never answers; Engine is killed mid-send and started again on the
//    same storage. The nudge is re-sent under the same key once its lease
//    runs out, and the stand-in delivers it once.
// Prints every send the stand-in saw and exits non-zero on any mismatch.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintHandleGrant, personIdForHandle, verifyEngineSend } from "@mano/protocol";

const AGENT_TOKEN = "local-agent-token-not-real";
const GRANT_SECRET = "local-grant-secret-not-real";
const SEND_SECRET = "local-engine-send-secret-not-real";
const ENGINE_PORT = 8799;
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mano-deadline-alarm-"));

const sends = [];
const delivered = new Set();
let hangNext = false;
const standIn = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const verified = await verifyEngineSend(
    SEND_SECRET,
    {
      method: req.method,
      path: req.url,
      timestamp: req.headers["x-mano-engine-timestamp"],
      signature: req.headers["x-mano-engine-signature"],
      body,
    },
    Math.floor(Date.now() / 1000),
  );
  const send = JSON.parse(body);
  const duplicate = delivered.has(send.key);
  sends.push({ at: new Date().toISOString(), signed: verified.ok, duplicate, ...send });
  console.log(`stand-in: ${duplicate ? "duplicate" : "delivered"} ${send.key} ${JSON.stringify(send.text)} signed=${verified.ok}`);
  if (!verified.ok) return res.writeHead(401).end();
  delivered.add(send.key);
  if (hangNext && !duplicate) {
    hangNext = false;
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(duplicate ? { sent: true, duplicate: true } : { sent: true }));
});
await new Promise((r) => standIn.listen(0, "127.0.0.1", r));
const channelsUrl = `http://127.0.0.1:${standIn.address().port}`;

// Pacific wall time, the default zone for a person with no profile state.
function pacific(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

let engine = null;
async function startEngine(nudgeTime) {
  const envFile = join(work, "engine.env");
  writeFileSync(
    envFile,
    [
      "MANO_ENV=development",
      "SESSION_SECRET=local-session-secret-not-real",
      "ENCRYPTION_KEK_B64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      `MANO_ENGINE_AGENT_TOKEN=${AGENT_TOKEN}`,
      `MANO_HANDLE_GRANT_SECRET=${GRANT_SECRET}`,
      "MANO_ENGINE_CHANNELS_TOKEN=local-channels-token-not-real",
      `MANO_ENGINE_SEND_SECRET=${SEND_SECRET}`,
      `MANO_CHANNELS_URL=${channelsUrl}`,
      `MANO_NUDGE_TIME=${nudgeTime}`,
    ].join("\n"),
  );
  engine = spawn(
    "npx",
    ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(ENGINE_PORT), "--persist-to", join(work, "state"), "--env-file", envFile, "--show-interactive-dev-session=false"],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  engine.stdout.on("data", (d) => process.env.DEBUG && process.stdout.write(d));
  engine.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${ENGINE_PORT}/health`)).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Engine did not start.");
}

function killEngine() {
  process.kill(-engine.pid, "SIGKILL");
  engine = null;
}

async function api(handleHash, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}/api/persons/${personIdForHandle(handleHash)}${path}`, {
    method,
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-mano-handle-grant": await mintHandleGrant(handleHash, GRANT_SECRET), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

function nudgeTimeSoon() {
  const now = Date.now();
  const soon = pacific(now + 2 * 60_000);
  const [h] = soon.time.split(":").map(Number);
  if (h < 9 || h >= 20) throw new Error("Run this between 9:00 and 19:55 Pacific: nudges only go out inside that window.");
  return { time: soon.time, today: pacific(now).date };
}

const failures = [];
const expect = (ok, what) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${what}`);
  if (!ok) failures.push(what);
};

try {
  // 1. The alarm fires by itself.
  const one = nudgeTimeSoon();
  await startEngine(one.time);
  const h1 = "a1".repeat(32);
  const due1 = addDays(one.today, 12);
  const created = await api(h1, "POST", "/deadlines", {
    title: "CalFresh renewal",
    dueDate: due1,
    program: "CalFresh",
    kind: "renewal",
    source: { kind: "letter", documentId: "synthetic-letter-1", sentence: "Return your renewal by the date above." },
    idempotencyKey: "letter:synthetic-letter-1:renewal",
    generation: 0,
  });
  console.log(`tracked: ${created.status} ${created.body.status}, nudges ${JSON.stringify(created.body.deadline.nudges.map((n) => [n.daysBefore, n.at]))}`);
  expect(created.status === 201, "POST /deadlines created the deadline");
  const first = created.body.deadline.nudges[0];
  console.log(`waiting for the alarm at ${first.at} (${one.time} Pacific)...`);
  await until(() => sends.some((s) => s.key === `reminder:${first.reminderId}`), 4 * 60_000, "the first nudge");
  const got = sends.find((s) => s.key === `reminder:${first.reminderId}`);
  expect(got.text === first.text, `exact text: ${JSON.stringify(got.text)}`);
  expect(got.signed, "signed with the engine send secret");
  expect(Date.parse(got.at) >= Date.parse(first.at), "not before its time");
  await until(async () => (await api(h1, "GET", "/deadlines")).body.deadlines[0].nudges[0].status === "sent", 30_000, "sent status");
  expect(true, "Engine marked it sent");
  killEngine();

  // 2. Killed mid-send, started again, delivered once.
  const two = nudgeTimeSoon();
  await startEngine(two.time);
  const h2 = "b2".repeat(32);
  const tracked = await api(h2, "POST", "/deadlines", {
    title: "Medi-Cal renewal",
    dueDate: addDays(two.today, 12),
    program: "Medi-Cal",
    kind: "renewal",
    source: { kind: "letter", documentId: "synthetic-letter-2" },
    idempotencyKey: "letter:synthetic-letter-2:renewal",
    generation: 0,
  });
  const nudge = tracked.body.deadline.nudges[0];
  const key = `reminder:${nudge.reminderId}`;
  hangNext = true;
  console.log(`waiting for the alarm at ${nudge.at}; the stand-in will take it and never answer...`);
  await until(() => sends.some((s) => s.key === key), 4 * 60_000, "the hung send");
  killEngine();
  console.log("Engine killed mid-send; starting it again on the same storage.");
  await startEngine(two.time);
  // The lease is two minutes from the dead claim. Wait for the alarm on
  // its own first; only then nudge the agent awake with a read, as the
  // person's next text would.
  const woke = await until(() => sends.filter((s) => s.key === key).length > 1, 3 * 60_000, "the re-send").then(
    () => "by itself",
    async () => {
      await api(h2, "GET", "/deadlines");
      await until(() => sends.filter((s) => s.key === key).length > 1, 3 * 60_000, "the re-send after a read");
      return "after a read woke the agent";
    },
  );
  console.log(`re-sent ${woke}.`);
  const forKey = sends.filter((s) => s.key === key);
  expect(forKey.length === 2 && !forKey[0].duplicate && forKey[1].duplicate, "re-sent under the same key, delivered once");
  await until(async () => (await api(h2, "GET", "/deadlines")).body.deadlines[0].nudges[0].status === "sent", 30_000, "sent status");
  expect(true, "Engine marked it sent after the restart");
  const before = sends.length;
  await new Promise((r) => setTimeout(r, 10_000));
  expect(sends.length === before, "nothing more went out");
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  if (engine) killEngine();
  standIn.close();
}
console.log(JSON.stringify({ sends }, null, 2));
process.exit(failures.length ? 1 : 0);
