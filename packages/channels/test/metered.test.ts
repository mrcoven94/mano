import { describe, expect, it, vi } from "vitest";
import { MemorySink, MeterRecorder, type UsageRecord } from "@mano/meter";
import { ResponderFailed, SparkResponder, StandInResponder } from "../src/responder.js";
import { MeteredResponder, meterResponder, type MeteredResponderOptions } from "../src/metered.js";

function metered(
  inner: ConstructorParameters<typeof MeteredResponder>[0],
  opts: Omit<MeteredResponderOptions, "meter"> = {},
) {
  const sink = new MemorySink();
  const meter = new MeterRecorder([sink]);
  const responder = new MeteredResponder(inner, { meter, ...opts });
  return { sink, meter, responder };
}

function okFetch(text: string, usage: Record<string, unknown> = {}) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "completed",
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          output_tokens_details: { reasoning_tokens: 30 },
          ...usage,
        },
        output: [{ content: [{ type: "output_text", text }] }],
      }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
}

function failFast<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} hung`)), 2000)),
  ]);
}

describe("MeteredResponder", () => {
  it("records the provider's real usage without changing model selection", async () => {
    const inner = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: okFetch("First. Second.") });
    const { sink, responder } = metered(inner);
    expect(responder.name).toBe(inner.name);
    expect(responder.maxAttempts).toBe(inner.maxAttempts);
    const result = await failFast(responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 }), "respond");
    expect(result.model).toBe("muse-spark-1.3");
    expect(result.model).not.toContain("contributor");
    await responder.flush();
    expect(sink.records).toHaveLength(1);
    const record = sink.records[0]!;
    expect(record).toMatchObject({
      package: "channels",
      purpose: "answer-texts",
      provider: "meta",
      model: "muse-spark-1.3",
      dataClass: "real",
      environment: "local",
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 30,
      status: "ok",
    });
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("records zero-cost stand-in answers under their own model label", async () => {
    const inner = new StandInResponder(["Recorded reply."]);
    const { sink, responder } = metered(inner);
    const result = await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    expect(result.model).toBe("stand-in");
    await responder.flush();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      package: "channels",
      provider: "stand-in",
      model: "stand-in",
      status: "ok",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
    });
  });

  it("records one record per attempt when the provider retries", async () => {
    const recovered = okFetch("Recovered.");
    let calls = 0;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 500 });
      return recovered(...args);
    }) as unknown as typeof fetch;
    const inner = new SparkResponder({ apiKey: "test-key-not-real", fetchFn, maxRetries: 1 });
    const { sink, responder } = metered(inner);
    const result = await failFast(responder.respond({ texts: ["Hi"], attachmentCount: 0 }), "respond");
    expect(result.attempts).toBe(2);
    await responder.flush();
    expect(sink.records).toHaveLength(2);
    expect(sink.records[0]).toMatchObject({ status: "error", inputTokens: 0, outputTokens: 0, latencyMs: 0 });
    expect(sink.records[1]).toMatchObject({
      status: "ok",
      model: "muse-spark-1.3",
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 30,
    });
    expect(sink.records[1]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records zero usage when the provider reports none", async () => {
    const bare = vi.fn(async () =>
      new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "Hi." }] }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const inner = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: bare });
    const { sink, responder } = metered(inner);
    await responder.respond({ texts: ["Hi"], attachmentCount: 0 });
    await responder.flush();
    expect(sink.records[0]).toMatchObject({ status: "ok", inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  });

  it("records error attempts and rethrows the original error", async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [] }), { status: 200 }));
    const inner = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: empty as typeof fetch, maxRetries: 0 });
    const { sink, responder } = metered(inner);
    const err = await responder.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    await responder.flush();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      package: "channels",
      provider: "meta",
      model: "muse-spark-1.3",
      status: "error",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("respects dataClass, environment and provider overrides", async () => {
    const inner = new StandInResponder(["Synthetic reply."]);
    const { sink, responder } = metered(inner, { dataClass: "synthetic", environment: "ci", provider: "meta" });
    await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    await responder.flush();
    expect(sink.records[0]).toMatchObject({ dataClass: "synthetic", environment: "ci", provider: "meta" });
  });

  it("answers without waiting for a slow meter", async () => {
    let release!: (record: UsageRecord) => void;
    const gate = new Promise<UsageRecord>((resolve) => {
      release = resolve;
    });
    const inner = new StandInResponder(["Quick."]);
    const sink = new MemorySink();
    const meter = new MeterRecorder([sink]);
    const slow = { record: async (input: Parameters<MeterRecorder["record"]>[0]) => gate.then(() => meter.record(input)) };
    const responder = new MeteredResponder(inner, { meter: slow });
    const result = await failFast(responder.respond({ texts: ["Hello"], attachmentCount: 0 }), "respond");
    expect(result.text).toBe("Quick.");
    expect(sink.records).toHaveLength(0);
    release({} as UsageRecord);
    await responder.flush();
    expect(sink.records).toHaveLength(1);
  });

  it("answers when the meter hangs forever", async () => {
    const inner = new StandInResponder(["Answered anyway."]);
    const hanging = { record: () => new Promise<never>(() => {}) };
    const responder = new MeteredResponder(inner, { meter: hanging });
    const result = await failFast(responder.respond({ texts: ["Hello"], attachmentCount: 0 }), "respond");
    expect(result.text).toBe("Answered anyway.");
  });

  it("never lets a failing meter break a reply", async () => {
    const inner = new StandInResponder(["Still answered."]);
    const onMeterError = vi.fn();
    const responder = new MeteredResponder(inner, {
      meter: { record: async () => { throw new Error("meter is down"); } },
      onMeterError,
    });
    const result = await failFast(responder.respond({ texts: ["Hello"], attachmentCount: 0 }), "respond");
    expect(result.text).toBe("Still answered.");
    await responder.flush();
    expect(onMeterError).toHaveBeenCalledTimes(1);
  });

  it("never lets a throwing error hook break a reply or the flush", async () => {
    const inner = new StandInResponder(["Answered."]);
    const responder = new MeteredResponder(inner, {
      meter: { record: async () => { throw new Error("meter is down"); } },
      onMeterError: () => { throw new Error("hook is down"); },
    });
    const result = await failFast(responder.respond({ texts: ["Hello"], attachmentCount: 0 }), "respond");
    expect(result.text).toBe("Answered.");
    await failFast(responder.flush(), "flush");
    const err = await new MeteredResponder(
      new SparkResponder({
        apiKey: "test-key-not-real",
        maxRetries: 0,
        fetchFn: (async () => new Response("no", { status: 500 })) as typeof fetch,
      }),
      {
        meter: { record: async () => { throw new Error("meter is down"); } },
        onMeterError: () => { throw new Error("hook is down"); },
      },
    )
      .respond({ texts: ["Hi"], attachmentCount: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
  });

  it("hands record promises to waitUntil when the worker passes one", async () => {
    const inner = new StandInResponder(["Held."]);
    const sink = new MemorySink();
    const seen: Array<Promise<unknown>> = [];
    const responder = new MeteredResponder(inner, {
      meter: new MeterRecorder([sink]),
      waitUntil: (promise) => void seen.push(promise),
    });
    await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    expect(seen).toHaveLength(1);
    await Promise.all(seen);
    expect(sink.records).toHaveLength(1);
  });

  it("survives a throwing waitUntil", async () => {
    const inner = new StandInResponder(["Answered."]);
    const responder = new MeteredResponder(inner, {
      meter: new MeterRecorder([new MemorySink()]),
      waitUntil: () => { throw new Error("ctx is gone"); },
    });
    const result = await failFast(responder.respond({ texts: ["Hello"], attachmentCount: 0 }), "respond");
    expect(result.text).toBe("Answered.");
  });

  it("keeps the meterResponder helper working", async () => {
    const sink = new MemorySink();
    const responder = meterResponder(new StandInResponder(["Hi."]), new MeterRecorder([sink]), { environment: "ci" });
    await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    await (responder as MeteredResponder).flush();
    expect(sink.records[0]).toMatchObject({ environment: "ci", status: "ok" });
  });
});
