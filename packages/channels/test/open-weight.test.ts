import { describe, expect, it, vi } from "vitest";
import { AgentResponder } from "../src/agent.js";
import { ModelCrisisCheck } from "../src/crisis-check.js";
import { OpenWeightClient, PrimaryBreaker, PRIMARY_SKIP_MS, type OpenWeightFallback } from "../src/open-weight.js";
import { ResponderFailed, SparkResponder } from "../src/responder.js";

const PRIMARY = "test-model-standard";
const OPEN = "meta/muse-spark-open";
const PRIMARY_URL = "https://api.meta.ai/v1/responses";
const OPEN_URL = "https://openrouter.ai/api/v1/chat/completions";

function primaryReply(text: string): Response {
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] }), { status: 200 });
}

function openReply(text: string, finish = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { role: "assistant", content: text } }] }), { status: 200 });
}

type Handler = (init: RequestInit) => Response | Promise<Response>;

// A fetch that answers each host from its own script and records every
// request with its parsed body.
function hosts(primary: Handler[], open: Handler[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const queue = url === PRIMARY_URL ? primary : url === OPEN_URL ? open : [];
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return next(init);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls, to: (url: string) => calls.filter((c) => c.url === url) };
}

const status = (code: number): Handler => () => new Response("{}", { status: code });
const answer = (text: string): Handler => () => primaryReply(text);
const open = (text: string, finish?: string): Handler => () => openReply(text, finish);
// Never answers; rejects when the request is aborted.
const hang: Handler = (init) =>
  new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function setup(primary: Handler[], fallback: Handler[], opts: { now?: () => number; timeoutMs?: number; withFallback?: boolean } = {}) {
  const net = hosts(primary, fallback);
  const breaker = new PrimaryBreaker(PRIMARY_SKIP_MS, opts.now ?? (() => 0));
  const openWeight: OpenWeightFallback = { client: new OpenWeightClient({ apiKey: "test-open-key-not-real", model: OPEN, fetchFn: net.fetchFn }), breaker };
  const responder = new SparkResponder({
    apiKey: "test-key-not-real",
    model: PRIMARY,
    fetchFn: net.fetchFn,
    hedgeAfterMs: 10_000,
    timeoutMs: opts.timeoutMs,
    openWeight: opts.withFallback === false ? undefined : openWeight,
  });
  return { ...net, breaker, responder };
}

const turn = { texts: ["my food stamps are ending"], attachmentCount: 0 };

describe("the open-weight fallback answers when the Meta Model API is down", () => {
  it("answers from the fallback when the primary says 402", async () => {
    const t = setup([status(402)], [open("Your benefits renew every year. When does your letter say they end?")]);
    const result = await t.responder.respond(turn);
    expect(result.text).toBe("Your benefits renew every year. When does your letter say they end?");
    expect(result.model).toBe(OPEN);
    expect(t.to(PRIMARY_URL)).toHaveLength(1);
    expect(t.to(OPEN_URL)).toHaveLength(1);
    expect(result.usage?.map((u) => [u.model, u.requests])).toEqual([
      [PRIMARY, 1],
      [OPEN, 1],
    ]);
  });

  it("answers from the fallback after the primary's retries all return 5xx", async () => {
    const t = setup([status(503), status(502), status(500)], [open("Here is what I found.")]);
    const result = await t.responder.respond(turn);
    expect(result).toMatchObject({ text: "Here is what I found.", model: OPEN, attempts: 4 });
    expect(t.to(PRIMARY_URL)).toHaveLength(3);
  });

  it("answers from the fallback when the primary times out, without waiting on the primary twice", async () => {
    const t = setup([hang, hang, hang], [open("Here is what I found.")], { timeoutMs: 30 });
    const result = await t.responder.respond(turn);
    expect(result).toMatchObject({ text: "Here is what I found.", model: OPEN });
    expect(t.to(PRIMARY_URL)).toHaveLength(1);
  });

  it("falls back on the deep call too, after the heads-up went out from the primary", async () => {
    const t = setup([answer("DEEP: Let me check your state's numbers."), status(503), status(503), status(503)], [open("You likely qualify.")]);
    const headsUps: string[] = [];
    const result = await t.responder.respond(turn, { onHeadsUp: async (text) => void headsUps.push(text) });
    expect(headsUps).toEqual(["Let me check your state's numbers."]);
    expect(result).toMatchObject({ text: "You likely qualify.", model: OPEN });
    const deep = t.to(OPEN_URL)[0]!.body;
    expect(deep.reasoning).toEqual({ effort: "medium", exclude: true });
    expect((deep.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: "assistant", content: "Let me check your state's numbers." });
  });

  it("gives no fallback for a bad key, a bad request or a rate limit: those are ours to fix", async () => {
    for (const code of [400, 401, 403, 429]) {
      const t = setup(code === 429 ? [status(429), status(429), status(429)] : [status(code)], []);
      const err = await t.responder.respond(turn).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResponderFailed);
      expect((err as ResponderFailed).reason).toBe(`http_${code}`);
      expect(t.to(OPEN_URL)).toHaveLength(0);
    }
  });

  it("fails with both reasons and every request counted when the fallback fails too", async () => {
    const t = setup([status(402)], [status(503)]);
    const err = (await t.responder.respond(turn).catch((e: unknown) => e)) as ResponderFailed;
    expect(err).toBeInstanceOf(ResponderFailed);
    expect(err.reason).toBe("primary_http_402,fallback_http_503");
    expect(err.attempts).toBe(2);
    expect(err.usage?.map((u) => u.model)).toEqual([PRIMARY, OPEN]);
  });

  it("refuses a cut-off or empty fallback answer", async () => {
    for (const [handler, reason] of [
      [open("Half an ans", "length"), "fallback_incomplete"],
      [open("   "), "fallback_empty"],
      [() => new Response(JSON.stringify({ choices: [] }), { status: 200 }), "fallback_incomplete"],
    ] as const) {
      const t = setup([status(402)], [handler]);
      const err = (await t.responder.respond(turn).catch((e: unknown) => e)) as ResponderFailed;
      expect(err.reason).toBe(`primary_http_402,${reason}`);
    }
  });

  it("declares one more request per call for the fallback in its worst case", () => {
    expect(setup([], []).responder.maxAttempts).toBe(11);
    expect(setup([], [], { withFallback: false }).responder.maxAttempts).toBe(9);
  });
});

describe("the agent's plain answer has the same fallback", () => {
  it("answers from the open-weight model when the agent and the primary are both down, counting the agent's request", async () => {
    const t = setup([status(402)], [open("Here is what I found.")]);
    const agent = new AgentResponder({
      agentUrl: "https://agent.example",
      secret: "test-secret-not-real",
      grantSecret: "test-grant-secret-not-real",
      handleHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      fallback: t.responder,
      timeoutMs: 1000,
      fetchFn: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
    });
    const result = await agent.respond({ ...turn, turnKey: { generation: 0, turn: 1 }, receivedAtMs: 0 });
    expect(result).toMatchObject({ text: "Here is what I found.", model: OPEN, attempts: 3 });
    expect(result.usage?.map((u) => [u.model, u.requests])).toEqual([
      [PRIMARY, 1],
      [OPEN, 1],
      ["agent", 1],
    ]);
  });
});

describe("every request to the fallback is pinned to zero-retention endpoints", () => {
  it("sends zdr true and data_collection deny on replies, deep calls and crisis checks", async () => {
    const t = setup([status(402)], [open("DEEP: One moment."), open("Answer."), open("no")]);
    await t.responder.respond(turn);
    const check = new ModelCrisisCheck({
      apiKey: "test-key-not-real",
      model: PRIMARY,
      fetchFn: t.fetchFn,
      openWeight: { client: new OpenWeightClient({ apiKey: "test-open-key-not-real", model: OPEN, fetchFn: t.fetchFn }), breaker: t.breaker },
    });
    expect(await check.ask("is it safe to take two advil", AbortSignal.timeout(3000))).toBe("no");
    const bodies = t.to(OPEN_URL).map((c) => c.body);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
      expect(body.model).toBe(OPEN);
    }
  });

  it("sends the instructions as the system message and the conversation as roles", async () => {
    const t = setup([status(402)], [open("Hi.")]);
    await t.responder.respond({ texts: ["hi"], attachmentCount: 0, history: [{ role: "mano", text: "Hi, I'm Mano." }] });
    const body = t.to(OPEN_URL)[0]!.body;
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages.slice(1)).toEqual([
      { role: "assistant", content: "Hi, I'm Mano." },
      { role: "user", content: "hi" },
    ]);
    expect(body).toMatchObject({ max_tokens: 8192, reasoning: { effort: "minimal", exclude: true } });
    expect(body).not.toHaveProperty("tools");
  });

  it("runs only on a Meta model ID", () => {
    expect(() => new OpenWeightClient({ apiKey: "k", model: "openai/gpt-4o" })).toThrow();
    expect(() => new OpenWeightClient({ apiKey: "k", model: "muse-spark-open" })).toThrow();
    expect(() => new OpenWeightClient({ apiKey: "", model: OPEN })).toThrow();
    expect(new OpenWeightClient({ apiKey: "k", model: "meta-llama/llama-4-maverick" }).model).toBe("meta-llama/llama-4-maverick");
  });
});

describe("the breaker skips a failing primary for a while, then asks it again", () => {
  it("sends later turns straight to the fallback, and the primary again once the window passes", async () => {
    let now = 0;
    const t = setup([status(402), answer("Back on the primary.")], [open("First."), open("Second.")], { now: () => now });
    expect((await t.responder.respond(turn)).text).toBe("First.");
    expect(t.breaker.skipPrimary()).toBe(true);
    now += PRIMARY_SKIP_MS - 1;
    expect((await t.responder.respond(turn)).text).toBe("Second.");
    expect(t.to(PRIMARY_URL)).toHaveLength(1);
    now += 1;
    const back = await t.responder.respond(turn);
    expect(back).toMatchObject({ text: "Back on the primary.", model: PRIMARY });
    expect(t.to(PRIMARY_URL)).toHaveLength(2);
    expect(t.to(OPEN_URL)).toHaveLength(2);
  });

  it("is shared: a trip from one responder sends another one's turn to the fallback", async () => {
    const t = setup([status(402)], [open("One."), open("Two.")]);
    await t.responder.respond(turn);
    const other = new SparkResponder({
      apiKey: "test-key-not-real",
      model: PRIMARY,
      fetchFn: t.fetchFn,
      openWeight: { client: new OpenWeightClient({ apiKey: "test-open-key-not-real", model: OPEN, fetchFn: t.fetchFn }), breaker: t.breaker },
    });
    expect((await other.respond(turn)).text).toBe("Two.");
    expect(t.to(PRIMARY_URL)).toHaveLength(1);
  });
});

describe("without a fallback the responder works exactly as before", () => {
  it("fails on a 402 with one request and calls nothing else", async () => {
    const t = setup([status(402)], [], { withFallback: false });
    const err = (await t.responder.respond(turn).catch((e: unknown) => e)) as ResponderFailed;
    expect(err).toBeInstanceOf(ResponderFailed);
    expect(err.reason).toBe("http_402");
    expect(err.usage).toBeUndefined();
    expect(t.calls.map((c) => c.url)).toEqual([PRIMARY_URL]);
  });

  it("still retries a timed-out primary and reports no per-model usage", async () => {
    const t = setup([hang, hang, answer("Late but here.")], [], { timeoutMs: 30, withFallback: false });
    const result = await t.responder.respond(turn);
    expect(result).toMatchObject({ text: "Late but here.", model: PRIMARY, attempts: 3 });
    expect(result.usage).toBeUndefined();
    expect(t.to(OPEN_URL)).toHaveLength(0);
  });
});

describe("the crisis check uses the same fallback", () => {
  function check(primary: Handler[], fallback: Handler[], breaker = new PrimaryBreaker(PRIMARY_SKIP_MS, () => 0), withFallback = true) {
    const net = hosts(primary, fallback);
    const c = new ModelCrisisCheck({
      apiKey: "test-key-not-real",
      model: PRIMARY,
      fetchFn: net.fetchFn,
      hedgeAfterMs: 2000,
      openWeight: withFallback ? { client: new OpenWeightClient({ apiKey: "test-open-key-not-real", model: OPEN, fetchFn: net.fetchFn }), breaker } : undefined,
    });
    return { ...net, check: c, breaker };
  }

  it("asks the fallback at once when the primary is down, without waiting for the hedge", async () => {
    const t = check([status(402)], [open("no")]);
    const started = Date.now();
    expect(await t.check.ask("is it safe to take two advil", AbortSignal.timeout(3000))).toBe("no");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.to(PRIMARY_URL)).toHaveLength(1);
    expect(t.to(OPEN_URL)[0]!.body).toMatchObject({ max_tokens: 512, reasoning: { effort: "minimal", exclude: true } });
  });

  it("skips the primary while the reply path's breaker is open, and never trips it itself", async () => {
    const tripped = new PrimaryBreaker(PRIMARY_SKIP_MS, () => 0);
    tripped.trip();
    const t = check([], [open("no")], tripped);
    expect(await t.check.ask("is it safe to take two advil", AbortSignal.timeout(3000))).toBe("no");
    expect(t.to(PRIMARY_URL)).toHaveLength(0);
    const fresh = check([status(503)], [open("no")]);
    await fresh.check.ask("is it safe to take two advil", AbortSignal.timeout(3000));
    expect(fresh.breaker.skipPrimary()).toBe(false);
  });

  it("only an exact no from a complete fallback answer exempts", async () => {
    for (const [handler, expected] of [
      [open("yes"), "yes"],
      [open("No."), "yes"],
      [open("no", "length"), "yes"],
      [() => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "no" } }, { finish_reason: "stop", message: { role: "assistant", content: "no" } }] }), { status: 200 }), "yes"],
    ] as const) {
      const t = check([status(402)], [handler]);
      expect(await t.check.ask("is it safe to take two advil", AbortSignal.timeout(3000))).toBe(expected);
    }
  });

  it("fails, so the turn stays a crisis, when both are down", async () => {
    const t = check([status(402)], [status(500)]);
    await expect(t.check.ask("is it safe to take two advil", AbortSignal.timeout(3000))).rejects.toThrow();
  });

  it("without a fallback, a down primary fails the check as before and nothing else is called", async () => {
    const t = check([status(402), status(402)], [], undefined, false);
    await expect(t.check.ask("is it safe to take two advil", AbortSignal.timeout(3000))).rejects.toThrow();
    expect(t.to(OPEN_URL)).toHaveLength(0);
  });
});
