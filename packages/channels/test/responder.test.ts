import { describe, expect, it, vi } from "vitest";
import { DEEP_INSTRUCTIONS, MANO_SOUL, PACING } from "@mano/persona";
import { ResponderFailed, SparkResponder, StandInResponder } from "../src/responder.js";
import { RecordingChannel } from "../src/recording.js";
import { ChannelRefused, ChannelUncertain } from "../src/channel.js";

const MODEL = "test-model-standard";

function reply(text: string, status = "completed"): Response {
  return new Response(JSON.stringify({ status, output: [{ type: "message", content: [{ type: "output_text", text }] }] }), { status: 200 });
}

function scripted(...bodies: Array<Response | (() => Response)>) {
  const queue = [...bodies];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected model call");
    return typeof next === "function" ? next() : next;
  });
}

function bodyOf(fetchFn: ReturnType<typeof scripted>, call: number): Record<string, unknown> {
  const [, init] = fetchFn.mock.calls[call] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("SparkResponder", () => {
  it("sends Mano's soul as instructions and the conversation as roles, with store:false and no tools", async () => {
    const fetchFn = scripted(reply("First. Second."));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch });
    const result = await responder.respond({
      texts: ["what date is it due", "the letter says march"],
      attachmentCount: 0,
      history: [
        { role: "mano", text: "Hi, I'm Mano." },
        { role: "person", text: "I got a letter" },
        { role: "mano", text: "What does it say?" },
      ],
    });
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    const body = bodyOf(fetchFn, 0);
    expect(body.model).toBe(MODEL);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(8192);
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body.instructions).toBe(`${MANO_SOUL}\n\n${PACING}`);
    expect(body.input).toEqual([
      { role: "assistant", content: "Hi, I'm Mano." },
      { role: "user", content: "I got a letter" },
      { role: "assistant", content: "What does it say?" },
      { role: "user", content: "what date is it due\nthe letter says march" },
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(result).toMatchObject({ text: "First. Second.", model: MODEL, attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("routes deep: hands over the heads-up before asking for the full answer at medium effort", async () => {
    const order: string[] = [];
    const fetchFn = vi.fn(async () => {
      order.push(`call-${order.filter((o) => o.startsWith("call")).length + 1}`);
      return order.length === 1 ? reply("DEEP: Let me run your Ohio numbers, one minute.") : reply("You likely qualify for about $400 a month.");
    });
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch });
    const result = await responder.respond(
      { texts: ["I make $2,100 a month in Ohio, do I qualify for SNAP?"], attachmentCount: 0 },
      { onHeadsUp: async (text) => void order.push(`heads-up:${text}`) },
    );
    expect(order).toEqual(["call-1", "heads-up:Let me run your Ohio numbers, one minute.", "call-2"]);
    const deep = bodyOf(fetchFn as unknown as ReturnType<typeof scripted>, 1);
    expect(deep.reasoning).toEqual({ effort: "medium" });
    expect(deep.instructions).toBe(`${MANO_SOUL}\n\n${DEEP_INSTRUCTIONS}`);
    expect(deep.input).toEqual([
      { role: "user", content: "I make $2,100 a month in Ohio, do I qualify for SNAP?" },
      { role: "assistant", content: "Let me run your Ohio numbers, one minute." },
    ]);
    expect(result).toMatchObject({ text: "You likely qualify for about $400 a month.", attempts: 2 });
  });

  it("never routes a crisis deep, and makes sure the reply names 988 and 911", async () => {
    const fetchFn = scripted(reply("I'm so glad you told me. I'm here."));
    const onHeadsUp = vi.fn(async () => {});
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch });
    const result = await responder.respond({ texts: ["I don't want to be here anymore"], attachmentCount: 0 }, { onHeadsUp });
    expect(bodyOf(fetchFn, 0).instructions).toBe(MANO_SOUL);
    expect(onHeadsUp).not.toHaveBeenCalled();
    expect(result.text).toContain("988");
    expect(result.text).toContain("911");
    expect(result.text).toContain("I'm here.");
  });

  it("tells the model about photos in its instructions, not in the person's words", async () => {
    const fetchFn = scripted(reply("Got it."));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch });
    await responder.respond({ texts: ["here's the letter"], attachmentCount: 2 });
    const body = bodyOf(fetchFn, 0);
    expect(body.instructions).toContain("2 photos");
    expect(body.input).toEqual([{ role: "user", content: "here's the letter" }]);
  });

  it("lets per-task callers raise the reasoning effort", async () => {
    const fetchFn = scripted(reply("Deep."));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch, reasoningEffort: "high" });
    await responder.respond({ texts: ["Hi"], attachmentCount: 0 });
    expect(bodyOf(fetchFn, 0).reasoning).toEqual({ effort: "high" });
  });

  it("counts every attempt, including retries on both calls", async () => {
    const fetchFn = scripted(
      new Response("{}", { status: 503 }),
      reply("DEEP: Checking."),
      new Response("{}", { status: 503 }),
      new Response("{}", { status: 503 }),
      reply("Answer."),
    );
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch });
    const result = await responder.respond({ texts: ["Hi"], attachmentCount: 0 });
    expect(result.attempts).toBe(5);
    expect(responder.maxAttempts).toBe(9);
  });

  it("hedges a slow fast call with a second request, takes the first answer and aborts the other", async () => {
    let aborted = false;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      if (fetchFn.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return reply("Hey, it's Mano.");
    });
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as unknown as typeof fetch, hedgeAfterMs: 20 });
    const result = await responder.respond({ texts: ["hi"], attachmentCount: 0 });
    expect(result).toMatchObject({ text: "Hey, it's Mano.", attempts: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(aborted).toBe(true);
  });

  it("does not hedge the deep call", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return reply("DEEP: Checking.");
      await new Promise((r) => setTimeout(r, 60));
      return reply("Answer.");
    });
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch, hedgeAfterMs: 10 });
    const result = await responder.respond({ texts: ["hard"], attachmentCount: 0 });
    expect(result.attempts).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("declares a worst case that covers its instructions and both calls", () => {
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL });
    expect(responder.inputSlackChars).toBeGreaterThan(MANO_SOUL.length + PACING.length);
    expect(responder.maxOutputChars).toBe(2 * 32800);
  });

  it("opts out of gateway log collection when asked", async () => {
    const gatewayFetch = scripted(reply("Hi."));
    const gateway = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: gatewayFetch as typeof fetch, collectLogs: false });
    await gateway.respond({ texts: ["Hi"], attachmentCount: 0 });
    const [, gatewayInit] = gatewayFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((gatewayInit.headers as Record<string, string>)["cf-aig-collect-log"]).toBe("false");
    const directFetch = scripted(reply("Hi."));
    const direct = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: directFetch as typeof fetch });
    await direct.respond({ texts: ["Hi"], attachmentCount: 0 });
    const [, directInit] = directFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(directInit.headers as Record<string, string>).not.toHaveProperty("cf-aig-collect-log");
  });

  it("fails loud on an empty answer, carrying attempt costs", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [] }), { status: 200 }));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch, maxRetries: 0 });
    const err = await responder.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).attempts).toBe(1);
    expect((err as ResponderFailed).inputChars).toBeGreaterThan(MANO_SOUL.length);
  });

  it("carries the fast call's attempts into a failed deep call", async () => {
    const fetchFn = scripted(reply("DEEP: Checking."), new Response("{}", { status: 401 }));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch, maxRetries: 0 });
    const err = await responder.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).attempts).toBe(2);
    expect((err as ResponderFailed).reason).toBe("http_401");
  });

  it("carries a safe machine reason on failures", async () => {
    const starved = new SparkResponder({
      apiKey: "test-key-not-real",
      model: MODEL,
      fetchFn: scripted(new Response(JSON.stringify({ status: "incomplete" }), { status: 200 })) as typeof fetch,
      maxRetries: 0,
    });
    const err = await starved.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).reason).toBe("run_incomplete");
    const badKey = new SparkResponder({
      apiKey: "test-key-not-real",
      model: MODEL,
      fetchFn: scripted(new Response("{}", { status: 401 })) as typeof fetch,
      maxRetries: 0,
    });
    const deniedErr = await badKey.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect((deniedErr as ResponderFailed).reason).toBe("http_401");
  });

  it("requires a model ID from config", () => {
    expect(() => new SparkResponder({ apiKey: "test-key-not-real", model: "" })).toThrow();
  });
});

describe("StandInResponder", () => {
  it("routes a DEEP: reply like the real responder", async () => {
    const responder = new StandInResponder(["DEEP: Checking that.", "Here is the answer."]);
    const heads: string[] = [];
    const result = await responder.respond({ texts: ["Hard one"], attachmentCount: 0 }, { onHeadsUp: async (t) => void heads.push(t) });
    expect(heads).toEqual(["Checking that."]);
    expect(result.text).toBe("Here is the answer.");
  });

  it("replays recorded replies and records prompts", async () => {
    const responder = new StandInResponder(["Recorded one. Recorded two."]);
    const result = await responder.respond({ texts: ["Hello"], attachmentCount: 1 });
    expect(result.model).toBe("stand-in");
    expect(result.bubbles.join(" ")).toBe("Recorded one. Recorded two.");
    expect(responder.prompts).toHaveLength(1);
  });
});

describe("RecordingChannel", () => {
  const input = { to: "+15550000001", chatId: "chat_rec", text: "Hi", idempotencyKey: "key-1" };

  it("dedupes replays by key", async () => {
    const channel = new RecordingChannel();
    const first = await channel.send(input);
    const second = await channel.send(input);
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ messageId: first.messageId, duplicate: true });
    expect(channel.sends).toHaveLength(1);
  });

  it("replays scripted refusals and timeouts", async () => {
    const channel = new RecordingChannel();
    channel.scriptFailure("key-1", { kind: "refuse", status: 429, code: "conversation_streak_limit" });
    await expect(channel.send(input)).rejects.toBeInstanceOf(ChannelRefused);
    channel.scriptFailure("key-1", { kind: "timeout-then-absent" });
    await expect(channel.send(input)).rejects.toBeInstanceOf(ChannelUncertain);
    // The key was never consumed by a real send, so a later send works.
    expect((await channel.send(input)).duplicate).toBe(false);
  });

  it("models a lost response: the replay returns the original", async () => {
    const channel = new RecordingChannel();
    channel.scriptFailure("key-1", { kind: "timeout-then-present", messageId: "msg_lost_1" });
    await expect(channel.send(input)).rejects.toBeInstanceOf(ChannelUncertain);
    const replay = await channel.send(input);
    expect(replay).toMatchObject({ messageId: "msg_lost_1", duplicate: true });
    expect(channel.sends).toHaveLength(1);
  });
});

describe("SparkResponder crisis routing uses the broad check", () => {
  it("never routes a message the broad check matches to the deep path", async () => {
    const fetchFn = scripted(reply("DEEP: Let me look into that."), reply("unused"));
    const onHeadsUp = vi.fn(async () => {});
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch, hedgeAfterMs: 60_000 });
    await responder.respond({ texts: ["I am going to jump off a bridge"], attachmentCount: 0 }, { onHeadsUp });
    expect(bodyOf(fetchFn, 0).instructions).toBe(MANO_SOUL);
    expect(onHeadsUp).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("no corrective call (PR 74 review 3: every reply has words)", () => {
  it("returns a reaction-only answer as it came, with one call; the runner gives it words", async () => {
    const fetchFn = scripted(reply("REACT: like"));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", model: MODEL, fetchFn: fetchFn as typeof fetch, hedgeAfterMs: 60_000 });
    const result = await responder.respond({ texts: ["When is my SNAP renewal due?"], attachmentCount: 0, history: [] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: "", tapback: "like", attempts: 1 });
  });
});
