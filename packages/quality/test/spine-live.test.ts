// spine:live against a scripted deployment: a step passes only on what the
// deployment answered, the run stops at the first failure, and its report
// carries no secret or replay link.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { looksSpanish, runLive, type LiveConfig, type StepName } from "../src/spine-live.ts";

const QUESTION = "File your renewal?";
const CONFIRMATION = "SBX-123";
const REPLAY_TOKEN = "0123456789abcdef0123456789abcdef";
const REPLAY_LINK = `https://engine.test/fill/${REPLAY_TOKEN}`;
const REPLAY_PAGE = `<p>This is exactly what Mano will send when you reply YES. Nothing is sent before that.</p><img src="data:image/png;base64,AAAA"><dd>R-1042</dd>`;

interface Scene {
  text?: Response;
  photoText?: string;
  fillTurns?: { status: string; text: string }[];
  replayStatus?: number;
  replayPage?: string;
  yesTexts?: string[];
  receipt?: { externalId: string; simulated: boolean };
  portalStatus?: number;
  checker?: string;
  executor?: string;
  turnModel?: string;
}

function deployment(scene: Scene = {}): typeof fetch {
  const fills = [...(scene.fillTurns ?? [{ status: "waiting_approval", text: `Filled. ${QUESTION} See each step: ${REPLAY_LINK}` }])];
  const yeses = [...(scene.yesTexts ?? [`Done. Sent: Food benefits renewal. Confirmation ${CONFIRMATION}.`])];
  const model = scene.turnModel ?? "meta/muse-spark-open";
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") {
      return Response.json({ ok: true, live: { checker: scene.checker ?? "guardian", executor: scene.executor ?? "sandbox" } });
    }
    if (url.pathname === "/channels/mano/turn") {
      const body = JSON.parse(String(init?.body)) as { texts: string[]; documents: unknown[] };
      if (body.documents.length > 0) return Response.json({ status: "replied", text: scene.photoText ?? "Your renewal is due November 14, 2026.", model });
      if (fills.length === 0 || /^(YES|s[ií])$/.test(body.texts[0]!)) return Response.json({ status: "replied", text: yeses.shift() });
      if (/help|ayudar/.test(body.texts[0]!)) return scene.text ?? Response.json({ status: "replied", text: "Yes, send me the letter.", model });
      const fill = fills.shift()!;
      return Response.json({ ...fill, model, ...(fill.status === "waiting_approval" ? { approval: QUESTION, approvalId: "ap-1" } : {}) });
    }
    if (url.pathname === "/channels/mano/presented") return Response.json({ ok: true });
    if (url.pathname.endsWith("/documents")) return Response.json({ id: "doc" }, { status: 201 });
    if (url.pathname.endsWith("/deadlines")) return Response.json({ deadlines: [{ dueDate: "2026-11-14", status: "scheduled" }] });
    if (url.pathname.startsWith("/fill/")) return new Response(scene.replayPage ?? REPLAY_PAGE, { status: scene.replayStatus ?? 200 });
    if (url.pathname.endsWith("/approvals")) {
      return Response.json({ approvals: [{ id: "ap-1", outcome: { receipt: scene.receipt ?? { externalId: CONFIRMATION, simulated: false } } }] });
    }
    if (url.pathname.startsWith("/caseworker/")) return new Response(`<h1>${CONFIRMATION}</h1>`, { status: scene.portalStatus ?? 200 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function config(scene?: Scene, extra: Partial<LiveConfig> = {}): LiveConfig {
  return {
    agentUrl: "https://agent.test",
    engineUrl: "https://engine.test",
    portalUrl: "https://portal.test",
    agentSecret: "agent-secret-value",
    grantSecret: "grant-secret-value",
    engineChannelsToken: "channels-token-value",
    engineAgentToken: "agent-token-value",
    portalToken: "portal-token-value",
    lang: "en",
    fetchImpl: deployment(scene),
    sleep: async () => undefined,
    ...extra,
  };
}

const failedAt = async (scene: Scene): Promise<StepName | null> => (await runLive(config(scene))).failedStep;

test("a whole run reports every step, its model, and the portal's number", async () => {
  const run = await runLive(config());
  assert.equal(run.ok, true);
  assert.equal(run.confirmation, CONFIRMATION);
  assert.deepEqual(run.steps.map((s) => s.step), ["health", "text", "guardian", "photo", "deadline", "fill", "yes", "portal"]);
  assert.equal(run.steps.find((s) => s.step === "text")?.model, "meta/muse-spark-open");
  assert.equal(run.steps.find((s) => s.step === "fill")?.model, "meta/muse-spark-open");
  assert.match(run.steps.find((s) => s.step === "yes")?.model ?? "", /glimmer/i);
  assert.ok(run.steps.every((s) => s.ok && s.wallMs >= 0));
});

test("two runs use different handles", async () => {
  assert.notEqual((await runLive(config())).handle, (await runLive(config())).handle);
});

test("the report carries no secret and no replay link", async () => {
  const text = JSON.stringify(await runLive(config()));
  for (const secret of ["agent-secret-value", "grant-secret-value", "channels-token-value", "agent-token-value", "portal-token-value", REPLAY_TOKEN]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("a model account out of credit fails the text step and stops the run", async () => {
  const run = await runLive(config({ text: Response.json({ status: "failed", text: "", reason: "billing" }, { status: 502 }) }));
  assert.equal(run.failedStep, "text");
  assert.equal(run.steps.length, 2);
  assert.match(run.steps.at(-1)!.detail, /HTTP 502.*billing/);
});

test("a photo that was not read fails, even with a 200", async () => {
  assert.equal(await failedAt({ photoText: "I could not finish reading your photo." }), "photo");
});

test("the deadline counts only with its year", async () => {
  assert.equal(await failedAt({ photoText: "Your renewal is due November 14, 2024." }), "photo");
  assert.equal(await failedAt({ photoText: "Your renewal is due November 14." }), "photo");
});

test("a question with no replay link fails: the draft never used the computer", async () => {
  assert.equal(await failedAt({ fillTurns: [{ status: "waiting_approval", text: QUESTION }] }), "fill");
});

test("a replay link on another host fails and is not opened", async () => {
  assert.equal(await failedAt({ fillTurns: [{ status: "waiting_approval", text: `${QUESTION} https://elsewhere.test/fill/${REPLAY_TOKEN}` }] }), "fill");
});

test("a replay page that does not open fails, as when a screenshot is missing", async () => {
  assert.equal(await failedAt({ replayStatus: 404 }), "fill");
});

test("a replay page that opens with a notice or no screens fails", async () => {
  assert.equal(await failedAt({ replayPage: "<h1>This form changed</h1>" }), "fill");
  assert.equal(await failedAt({ replayPage: "This is exactly what Mano will send when you reply YES. R-1042" }), "fill");
});

test("Mano's questions are answered until the form is ready", async () => {
  const run = await runLive(
    config({
      fillTurns: [
        { status: "replied", text: "What is the case number on your renewal letter?" },
        { status: "waiting_approval", text: `${QUESTION} ${REPLAY_LINK}` },
      ],
    }),
  );
  assert.equal(run.ok, true);
  assert.equal(run.steps.find((s) => s.step === "fill")?.attempts, 2);
});

test("questions that never end fail instead of looping", async () => {
  const asking = Array.from({ length: 9 }, () => ({ status: "replied", text: "What is your date of birth?" }));
  assert.equal(await failedAt({ fillTurns: asking }), "fill");
});

test("a YES that files nothing fails", async () => {
  assert.equal(await failedAt({ yesTexts: ["That approval can no longer be used, so nothing was sent."] }), "yes");
});

test("a simulated filing fails", async () => {
  assert.equal(await failedAt({ yesTexts: [`Done. Confirmation ${CONFIRMATION}. This was a simulated filing.`] }), "yes");
});

test("a number Engine's receipt does not back fails", async () => {
  assert.equal(await failedAt({ receipt: { externalId: "OTHER", simulated: false } }), "yes");
});

test("a number the portal does not hold fails", async () => {
  assert.equal(await failedAt({ portalStatus: 404 }), "portal");
});

test("YES is sent again while Guardian starts, as Mano asks a person to", async () => {
  const run = await runLive(config({ yesTexts: ["The safety check is taking a moment, so nothing was sent yet.", `Done. Confirmation ${CONFIRMATION}.`] }));
  assert.equal(run.ok, true);
  assert.equal(run.steps.find((s) => s.step === "yes")?.attempts, 2);
});

test("an Engine without Guardian or the sandbox portal fails before any turn", async () => {
  assert.equal(await failedAt({ checker: "local-rules" }), "health");
  assert.equal(await failedAt({ executor: "simulated" }), "health");
});

test("Guardian that never comes up fails the run", async () => {
  const run = await runLive(config(undefined, { warmGuardian: async () => "starting" }));
  assert.equal(run.failedStep, "guardian");
});

test("a Spanish run fails on an English answer", async () => {
  const run = await runLive(config(undefined, { lang: "es" }));
  assert.equal(run.failedStep, "text");
  assert.equal(run.yesWord, "sí");
});

test("looksSpanish tells the two apart", () => {
  assert.equal(looksSpanish("Sí, te puedo ayudar con la renovación de tus beneficios de comida."), true);
  assert.equal(looksSpanish("Yes, I can help with the renewal of your food benefits."), false);
});

test("the command exits 2 and names what is missing, with no values", () => {
  const out = spawnSync(process.execPath, ["--import", "./src/register.ts", "src/bin/spine-live.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /MANO_AGENT_URL/);
});
