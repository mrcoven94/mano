import { describe, expect, it, vi } from "vitest";
import { MemorySink, MeterRecorder } from "@mano/meter";
import { buildMeter, buildResponder } from "../src/conversation.js";
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
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ package: "channels", purpose: "answer-texts", status: "ok" });
  });

  it("works with no METER binding and no injected recorder", async () => {
    const responder = buildResponder(baseEnv);
    const result = await responder.respond({ texts: ["Hi Mano"], attachmentCount: 0 });
    expect(result.bubbles.length).toBeGreaterThan(0);
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
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 12,
      status: "ok",
    });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]![0] as { blobs: string[]; doubles: number[] };
    expect(point.blobs).toContain("muse-spark-1.3");
    expect(point.doubles).toContain(10);
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
  });
});
