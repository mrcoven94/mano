/// <reference types="node" />
// The text line keeps answering when the Meta Model API is down: the
// worker's real responder and crisis check, with a fetch that plays the
// Meta Model API and the open-weight fallback, through the turn runner.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCrisisCheck, OpenWeightClient, PrimaryBreaker, SparkResponder, StandInResponder, type OpenWeightFallback } from "@mano/channels";
import { CRISIS_LINE, SAFE_REPLY } from "@mano/persona";
import { buildCrisisCheck, buildOpenWeight, buildResponder } from "../src/conversation.js";
import type { Env } from "../src/env.js";
import { SqlConversationStore } from "../src/store-sql.js";
import type { ConversationStore } from "../src/store.js";
import { INTRO_BUBBLE } from "../src/text.js";
import { inboundEvent, makeHarness, runTurnAfterBatch, sqliteStorage, type Harness } from "./helpers.js";

const PRIMARY = "muse-spark-1.3";
const OPEN = "meta/muse-spark-open";
const PRIMARY_URL = "https://api.meta.ai/v1/responses";
const OPEN_URL = "https://openrouter.ai/api/v1/chat/completions";

type Handler = () => Response | Promise<Response>;
const status = (code: number): Handler => () => new Response("{}", { status: code });
const primaryAnswer = (text: string): Handler => () =>
  new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] }), { status: 200 });
const openResponse = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] }), { status: 200 });
const openAnswer = (text: string): Handler => () => openResponse(text);

// Each host answers from its own script; an unscripted call is a 500.
function hosts(script: { primary?: Handler[]; open?: Handler[] }) {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (url === OPEN_URL) bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    const queue = url === PRIMARY_URL ? script.primary : url === OPEN_URL ? script.open : undefined;
    return (queue?.shift() ?? status(500))();
  };
  return { fetchFn: fetchFn as typeof fetch, urls, bodies, count: (url: string) => urls.filter((u) => u === url).length };
}

function line(script: { primary?: Handler[]; open?: Handler[] }, store?: ConversationStore) {
  const net = hosts(script);
  const openWeight: OpenWeightFallback = {
    client: new OpenWeightClient({ apiKey: "test-open-key-not-real", model: OPEN, fetchFn: net.fetchFn }),
    breaker: new PrimaryBreaker(),
  };
  const responder = new SparkResponder({ apiKey: "test-key-not-real", model: PRIMARY, fetchFn: net.fetchFn, maxRetries: 0, hedgeAfterMs: 10_000, openWeight });
  const crisisCheck = new ModelCrisisCheck({ apiKey: "test-key-not-real", model: PRIMARY, fetchFn: net.fetchFn, hedgeAfterMs: 10_000, openWeight });
  const h = makeHarness({ responder, crisisCheck, store });
  return { ...net, h };
}

async function say(h: Harness, id: string, text: string): Promise<string[]> {
  const before = h.channel.sends.length;
  await h.runner.handleEvent(inboundEvent({ id, text, occurredAtMs: h.now }), "webhook");
  await runTurnAfterBatch(h);
  return h.channel.sends.slice(before).map((s) => s.text);
}

const loggedEvents = (h: Harness, event: string) =>
  h.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event);

describe("a text gets an answer when the Meta Model API is down", () => {
  it("answers from the open-weight model on a 402, and records which model answered and what each cost", async () => {
    const t = line({ primary: [status(402)], open: [openAnswer("Food benefits usually need a renewal form. What does your letter say?")] });
    const sent = await say(t.h, "evt_1", "my food stamps are ending");
    expect(sent).toEqual([INTRO_BUBBLE, "Food benefits usually need a renewal form. What does your letter say?"]);
    const answered = loggedEvents(t.h, "turn_answered")[0]!;
    expect(answered).toMatchObject({ model: OPEN, models: `${PRIMARY},${OPEN}` });
    const { spentUsd, byModel } = t.h.ledger.spent();
    expect(Object.keys(byModel).sort()).toEqual([OPEN, PRIMARY].sort());
    expect(byModel[OPEN]).toBeGreaterThan(0);
    expect(byModel[OPEN]! + byModel[PRIMARY]!).toBeCloseTo(spentUsd, 10);
  });

  it("never names either model in what the person sees", async () => {
    const t = line({ primary: [status(503)], open: [openAnswer("I'm meta/muse-spark-open, here to help. What does the letter say?")] });
    const sent = await say(t.h, "evt_1", "who are you");
    for (const text of sent) expect(text.toLowerCase()).not.toMatch(/muse|meta|spark|openrouter/);
  });

  it("skips the failing primary on the next text, without asking it again", async () => {
    const t = line({ primary: [status(402)], open: [openAnswer("First answer."), openAnswer("Second answer.")] });
    await say(t.h, "evt_1", "hello");
    expect(await say(t.h, "evt_2", "and my rent help?")).toEqual(["Second answer."]);
    expect(t.count(PRIMARY_URL)).toBe(1);
    expect(t.count(OPEN_URL)).toBe(2);
    for (const body of t.bodies) expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  it("never names the fallback's provider or the host behind it (PR 102 review)", async () => {
    const t = line({
      primary: [status(402)],
      open: [openAnswer("This answer came through OpenRouter. Fireworks AI hosts the model and Nebius backs it up. Bring your letter to the office.")],
    });
    const sent = (await say(t.h, "evt_1", "who answers these texts")).join(" ");
    expect(sent).not.toMatch(/openrouter|fireworks|nebius/i);
    expect(sent).toContain("Bring your letter to the office.");
  });

  it("sends the safe line, with 988 and 911, when both models are down", async () => {
    const t = line({ primary: [status(402)], open: [status(503)] });
    expect(await say(t.h, "evt_1", "my food stamps are ending")).toEqual([INTRO_BUBBLE, SAFE_REPLY]);
    expect(loggedEvents(t.h, "responder_failed")[0]).toMatchObject({ reason: "primary_http_402,fallback_http_503", models: `${PRIMARY},${OPEN}` });
    expect(Object.keys(t.h.ledger.spent().byModel).sort()).toEqual([OPEN, PRIMARY].sort());
  });
});

describe("a crisis text never depends on the Meta Model API alone", () => {
  it("opens with the crisis line, naming 988 and 911, when every model is down", async () => {
    const t = line({ primary: [status(402)], open: [status(500)] });
    const sent = await say(t.h, "evt_1", "I want to end my life");
    expect(sent[0]).toBe(CRISIS_LINE);
    expect(sent.join(" ")).toMatch(/988/);
    expect(sent.join(" ")).toMatch(/911/);
  });

  it("sends the crisis line at once when the primary says 402 and the fallback is still working (PR 102 review, blocker)", async () => {
    let answerOpen!: (res: Response) => void;
    const working: Handler = () => new Promise<Response>((resolve) => (answerOpen = resolve));
    const t = line({ primary: [status(402)], open: [working] });
    await t.h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "I want to end my life", occurredAtMs: t.h.now }), "webhook");
    const turn = runTurnAfterBatch(t.h);
    await vi.waitFor(() => expect(t.count(OPEN_URL)).toBe(1));
    expect(t.h.channel.sends.map((s) => s.text)).toEqual([CRISIS_LINE]);
    answerOpen(openResponse("I'm here with you. What is happening tonight?"));
    await turn;
    expect(t.h.channel.sends.map((s) => s.text)).toEqual([CRISIS_LINE, "I'm here with you. What is happening tonight?"]);
  });

  it("gives a short health question the crisis line when the check and the reply both find every model down", async () => {
    const t = line({ primary: [status(402), status(402)], open: [status(500), status(500)] });
    t.h.store.patchMeta({ introduced: true });
    const sent = await say(t.h, "evt_1", "Should I stop taking my blood pressure pills?");
    expect(sent[0]).toBe(CRISIS_LINE);
    expect(loggedEvents(t.h, "crisis_check")[0]).toMatchObject({ crisis: true, reason: "check-error" });
  });

  it("lets the open-weight check exempt a short health question while the primary is down", async () => {
    const t = line({ primary: [status(402)], open: [openAnswer("no"), openAnswer("Do not stop them on your own. A doctor or pharmacist can tell you.")] });
    t.h.store.patchMeta({ introduced: true });
    const sent = await say(t.h, "evt_1", "Should I stop taking my blood pressure pills?");
    expect(sent).toEqual(["Do not stop them on your own. A doctor or pharmacist can tell you."]);
    expect(loggedEvents(t.h, "crisis_check")[0]).toMatchObject({ crisis: false, reason: "model-no" });
  });
});

describe("what each model cost survives a failed settlement and a restart (PR 102 review)", () => {
  it("settles the per-model breakdown when a new runner resumes the saved answer", async () => {
    const store = new SqlConversationStore(sqliteStorage(new DatabaseSync(":memory:")));
    const first = line({ primary: [status(402)], open: [openAnswer("Here is what I found.")] }, store);
    first.h.ledger.settle = () => {
      throw new Error("ledger down");
    };
    await first.h.runner.handleEvent(inboundEvent({ id: "evt_1", text: "my food stamps are ending", occurredAtMs: first.h.now }), "webhook");
    first.h.advance(first.h.batchMs + 100);
    expect(await first.h.runner.runDueTurn()).toBe("retry");
    // A restart: a new runner and ledger over the same stored turn.
    const restarted = line({}, store);
    restarted.h.now = first.h.now + 60_000;
    expect(await restarted.h.runner.runDueTurn()).toBe("ran");
    expect(restarted.urls).toEqual([]);
    expect(restarted.h.channel.sends.map((s) => s.text)).toContain("Here is what I found.");
    const { spentUsd, byModel } = restarted.h.ledger.spent();
    expect(spentUsd).toBeGreaterThan(0);
    expect(Object.keys(byModel).sort()).toEqual([OPEN, PRIMARY].sort());
    expect(byModel[OPEN]! + byModel[PRIMARY]!).toBeCloseTo(spentUsd, 10);
  });
});

describe("the worker turns the fallback on only with OPENROUTER_API_KEY", () => {
  const base = { META_MODEL_API_KEY: "test-key-not-real", MANO_REPLY_MODEL: PRIMARY, MANO_OPEN_WEIGHT_MODEL: OPEN } as Env;
  afterEach(() => vi.unstubAllGlobals());

  it("is off without the key, or with a model ID that is not Meta's or is a -contributor ID", () => {
    expect(buildOpenWeight(base)).toBeUndefined();
    expect(buildOpenWeight({ ...base, OPENROUTER_API_KEY: "test-open-key-not-real", MANO_OPEN_WEIGHT_MODEL: "openai/gpt-4o" })).toBeUndefined();
    expect(buildOpenWeight({ ...base, OPENROUTER_API_KEY: "test-open-key-not-real", MANO_OPEN_WEIGHT_MODEL: "meta/muse-spark-1.3-contributor" })).toBeUndefined();
    expect(buildOpenWeight({ ...base, OPENROUTER_API_KEY: "test-open-key-not-real", MANO_OPEN_WEIGHT_MODEL: "" })).toBeUndefined();
    expect(buildOpenWeight({ ...base, OPENROUTER_API_KEY: "test-open-key-not-real" })?.client.model).toBe(OPEN);
  });

  it("with the key, a 402 from the Meta Model API is answered by the fallback", async () => {
    const net = hosts({ primary: [status(402)], open: [openAnswer("Here to help.")] });
    vi.stubGlobal("fetch", net.fetchFn);
    const responder = buildResponder({ ...base, OPENROUTER_API_KEY: "test-open-key-not-real" }, undefined, { breaker: new PrimaryBreaker() });
    expect((await responder.respond({ texts: ["hi"], attachmentCount: 0 })).text).toBe("Here to help.");
    expect(net.urls).toEqual([PRIMARY_URL, OPEN_URL]);
  });

  it("without the key, a 402 fails the reply exactly as before and nothing else is called", async () => {
    const net = hosts({ primary: [status(402)] });
    vi.stubGlobal("fetch", net.fetchFn);
    const responder = buildResponder(base, undefined, { breaker: new PrimaryBreaker() });
    expect(responder).toBeInstanceOf(SparkResponder);
    expect(responder.maxAttempts).toBe(9);
    await expect(responder.respond({ texts: ["hi"], attachmentCount: 0 })).rejects.toMatchObject({ reason: "http_402", usage: undefined });
    expect(net.urls).toEqual([PRIMARY_URL]);
    const check = buildCrisisCheck(base);
    await expect(check!.ask("Should I stop taking my blood pressure pills?", AbortSignal.timeout(3000))).rejects.toThrow();
    expect(net.urls.filter((u) => u === OPEN_URL)).toEqual([]);
  });

  it("never adds a fallback to the stand-in: no Meta key still means no model at all", () => {
    expect(buildResponder({ OPENROUTER_API_KEY: "test-open-key-not-real", MANO_OPEN_WEIGHT_MODEL: OPEN } as Env)).toBeInstanceOf(StandInResponder);
    expect(buildCrisisCheck({ OPENROUTER_API_KEY: "test-open-key-not-real", MANO_OPEN_WEIGHT_MODEL: OPEN } as Env)).toBeNull();
  });
});
