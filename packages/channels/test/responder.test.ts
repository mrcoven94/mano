import { describe, expect, it, vi } from "vitest";
import { ResponderFailed, STANDARD_MODEL_ID, SparkResponder, StandInResponder, buildResponderInput } from "../src/responder.js";
import { RecordingChannel } from "../src/recording.js";
import { ChannelRefused, ChannelUncertain } from "../src/channel.js";

describe("SparkResponder", () => {
  it("asks the standard model with store:false and no tools", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: "First. Second." }] }],
        }),
        { status: 200 },
      ),
    );
    const responder = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: fetchFn as typeof fetch });
    const result = await responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 });
    expect(result.model).toBe(STANDARD_MODEL_ID);
    expect(result.model).not.toContain("contributor");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("muse-spark-1.3");
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(8192);
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body).not.toHaveProperty("tools");
    expect(result.bubbles.join(" ")).toBe("First. Second.");
    expect(result.attempts).toBe(1);
  });

  it("lets per-task callers raise the reasoning effort", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "Deep." }] }] }), {
        status: 200,
      }),
    );
    const responder = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: fetchFn as typeof fetch, reasoningEffort: "high" });
    await responder.respond({ texts: ["Hi"], attachmentCount: 0 });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as Record<string, unknown>).reasoning).toEqual({ effort: "high" });
  });

  it("counts every attempt, including retries", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("{}", { status: 503 });
      return new Response(
        JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "Late." }] }] }),
        { status: 200 },
      );
    });
    const responder = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: fetchFn as typeof fetch });
    const result = await responder.respond({ texts: ["Hi"], attachmentCount: 0 });
    expect(result.attempts).toBe(3);
    expect(responder.maxAttempts).toBe(3);
  });

  it("opts out of gateway log collection when asked", async () => {
    const ok = () =>
      new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "Hi." }] }] }), {
        status: 200,
      });
    const gatewayFetch = vi.fn(async () => ok());
    const gateway = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: gatewayFetch as typeof fetch, collectLogs: false });
    await gateway.respond({ texts: ["Hi"], attachmentCount: 0 });
    const [, gatewayInit] = gatewayFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((gatewayInit.headers as Record<string, string>)["cf-aig-collect-log"]).toBe("false");
    const directFetch = vi.fn(async () => ok());
    const direct = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: directFetch as typeof fetch });
    await direct.respond({ texts: ["Hi"], attachmentCount: 0 });
    const [, directInit] = directFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(directInit.headers as Record<string, string>).not.toHaveProperty("cf-aig-collect-log");
  });

  it("fails loud on an empty answer, carrying attempt costs", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [] }), { status: 200 }));
    const responder = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: fetchFn as typeof fetch, maxRetries: 0 });
    const err = await responder.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).attempts).toBe(1);
    expect((err as ResponderFailed).inputChars).toBeGreaterThan(0);
  });

  it("carries a safe machine reason on failures", async () => {
    const incomplete = vi.fn(async () => new Response(JSON.stringify({ status: "incomplete" }), { status: 200 }));
    const starved = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: incomplete as typeof fetch, maxRetries: 0 });
    const err = await starved.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).reason).toBe("run_incomplete");
    const denied = vi.fn(async () => new Response("{}", { status: 401 }));
    const badKey = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: denied as typeof fetch, maxRetries: 0 });
    const deniedErr = await badKey.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect((deniedErr as ResponderFailed).reason).toBe("http_401");
  });
});

describe("buildResponderInput", () => {
  it("keeps answers-only instructions in the prompt", () => {
    const input = buildResponderInput({ texts: ["File this for me"], attachmentCount: 0 });
    expect(input).toContain("no outside action");
    expect(input).toContain("File this for me");
  });
});

describe("StandInResponder", () => {
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
