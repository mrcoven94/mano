import { describe, expect, it, vi } from "vitest";
import { MemorySink, MeterRecorder } from "@mano/meter";
import { ResponderFailed, SparkResponder, StandInResponder } from "../src/responder.js";
import { estimateTokens, meterResponder } from "../src/metered.js";

function metered(inner: Parameters<typeof meterResponder>[0], opts: Parameters<typeof meterResponder>[2] = {}) {
  const sink = new MemorySink();
  const meter = new MeterRecorder([sink]);
  const responder = meterResponder(inner, meter, opts);
  return { sink, meter, responder };
}

function okFetch(text: string) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text }] }] }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
}

describe("MeteredResponder", () => {
  it("records one ok record after a live answer, without changing model selection", async () => {
    const inner = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: okFetch("First. Second.") });
    const { sink, responder } = metered(inner);
    expect(responder.name).toBe(inner.name);
    expect(responder.maxAttempts).toBe(inner.maxAttempts);
    const result = await responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 });
    expect(result.model).toBe("muse-spark-1.3");
    expect(result.model).not.toContain("contributor");
    expect(sink.records).toHaveLength(1);
    const record = sink.records[0]!;
    expect(record.package).toBe("channels");
    expect(record.purpose).toBe("answer-texts");
    expect(record.provider).toBe("meta");
    expect(record.model).toBe("muse-spark-1.3");
    expect(record.dataClass).toBe("real");
    expect(record.status).toBe("ok");
    expect(record.inputTokens).toBe(estimateTokens(result.inputChars));
    expect(record.outputTokens).toBe(estimateTokens(result.outputChars));
    expect(record.inputTokens).toBeGreaterThan(0);
    expect(record.outputTokens).toBeGreaterThan(0);
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("records zero-cost stand-in answers under their own model label", async () => {
    const inner = new StandInResponder(["Recorded reply."]);
    const { sink, responder } = metered(inner);
    const result = await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    expect(result.model).toBe("stand-in");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      package: "channels",
      provider: "stand-in",
      model: "stand-in",
      status: "ok",
      estimatedCostUsd: 0,
    });
  });

  it("records one error record when the inner responder fails, and rethrows unchanged", async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [] }), { status: 200 }));
    const inner = new SparkResponder({ apiKey: "test-key-not-real", fetchFn: empty as typeof fetch, maxRetries: 0 });
    const { sink, responder } = metered(inner);
    const err = await responder.respond({ texts: ["Hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      package: "channels",
      provider: "meta",
      model: "muse-spark-1.3",
      status: "error",
      outputTokens: 0,
    });
    expect(sink.records[0]!.inputTokens).toBeGreaterThan(0);
  });

  it("respects purpose, dataClass and provider overrides", async () => {
    const inner = new StandInResponder(["Synthetic reply."]);
    const { sink, responder } = metered(inner, { purpose: "eval-replay", dataClass: "synthetic", provider: "test" });
    await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    expect(sink.records[0]).toMatchObject({ purpose: "eval-replay", dataClass: "synthetic", provider: "test" });
  });

  it("never lets a failing meter break a reply", async () => {
    const inner = new StandInResponder(["Still answered."]);
    const onMeterError = vi.fn();
    const responder = meterResponder(
      inner,
      { record: async () => { throw new Error("meter is down"); } },
      { onMeterError },
    );
    const result = await responder.respond({ texts: ["Hello"], attachmentCount: 0 });
    expect(result.text).toBe("Still answered.");
    expect(onMeterError).toHaveBeenCalledTimes(1);
  });
});
