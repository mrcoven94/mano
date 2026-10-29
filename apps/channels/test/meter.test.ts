import { describe, expect, it, vi } from "vitest";
import { MemorySink, MeterRecorder } from "@mano/meter";
import { MeteredResponder } from "@mano/channels";
import { buildMeter, buildResponder, environmentEnv } from "../src/conversation.js";
import type { Env } from "../src/env.js";

const baseEnv = {
  META_MODEL_API_KEY: undefined,
  METER: undefined,
} as unknown as Env;

describe("buildResponder metering", () => {
  it("records one usage record per turn through the injected recorder", async () => {
    const sink = new MemorySink();
    const meter = new MeterRecorder([sink]);
    const responder = buildResponder(baseEnv, { meter });
    expect(responder.name).toBe("stand-in");
    const result = await responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 });
    expect(result.model).toBe("stand-in");
    await (responder as MeteredResponder).flush();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ package: "channels", purpose: "answer-texts", status: "ok", environment: "local" });
  });

  it("works with no METER binding and no injected recorder", async () => {
    const responder = buildResponder(baseEnv);
    const result = await responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 });
    expect(result.bubbles.length).toBeGreaterThan(0);
  });

  it("hands record promises to waitUntil when passed", async () => {
    const sink = new MemorySink();
    const seen: Array<Promise<unknown>> = [];
    const responder = buildResponder(baseEnv, {
      meter: new MeterRecorder([sink]),
      waitUntil: (promise) => void seen.push(promise),
    });
    await responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 });
    expect(seen).toHaveLength(1);
    await Promise.all(seen);
    expect(sink.records).toHaveLength(1);
  });

  it("writes to the METER dataset when bound", async () => {
    const writeDataPoint = vi.fn();
    const meter = buildMeter({ ...baseEnv, METER: { writeDataPoint } } as unknown as Env);
    const record = await meter.record({
      package: "channels",
      purpose: "answer-texts",
      provider: "meta",
      model: "muse-spark-1.3",
      dataClass: "real",
      environment: "production",
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
      latencyMs: 12,
      status: "ok",
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]![0] as { blobs: string[]; doubles: number[] };
    expect(point.blobs).toContain("muse-spark-1.3");
    expect(point.blobs).toContain("production");
    expect(point.doubles).toContain(10);
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe("environmentEnv", () => {
  it("prefers an explicit valid ENVIRONMENT", () => {
    expect(environmentEnv({ ...baseEnv, ENVIRONMENT: "preview" })).toBe("preview");
    expect(environmentEnv({ ...baseEnv, ENVIRONMENT: "ci", METER: { writeDataPoint: () => {} } })).toBe("ci");
  });

  it("falls back to the METER binding: bound means production, absent means local", () => {
    expect(environmentEnv(baseEnv)).toBe("local");
    expect(environmentEnv({ ...baseEnv, METER: { writeDataPoint: () => {} } } as unknown as Env)).toBe("production");
    expect(environmentEnv({ ...baseEnv, ENVIRONMENT: "staging", METER: { writeDataPoint: () => {} } } as unknown as Env)).toBe("production");
    expect(environmentEnv({ ...baseEnv, ENVIRONMENT: "staging" })).toBe("local");
  });
});
