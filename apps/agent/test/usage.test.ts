import { describe, expect, it } from "vitest";

import { buildRecord, estimateCostUsd, MemorySink, UsageRecorder } from "../agent/lib/usage.js";

const input = {
  package: "agent",
  purpose: "agent-turn",
  provider: "meta",
  model: "muse-spark-1.3",
  dataClass: "synthetic" as const,
  inputTokens: 1000,
  outputTokens: 500,
  latencyMs: 1200,
  status: "ok" as const,
};

describe("usage records", () => {
  it("builds a Meter-shaped record with estimated cost", () => {
    const record = buildRecord(input, "2026-10-29T00:00:00.000Z");
    expect(record).toEqual({
      ...input,
      estimatedCostUsd: estimateCostUsd("muse-spark-1.3", 1000, 500),
      at: "2026-10-29T00:00:00.000Z",
    });
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("drops content smuggled in extra keys", () => {
    const record = buildRecord({ ...input, prompt: "secret", answer: "secret", phone: "+1" } as typeof input);
    expect(record).not.toHaveProperty("prompt");
    expect(record).not.toHaveProperty("answer");
    expect(record).not.toHaveProperty("phone");
  });

  it("rejects other packages, bad classes, and overlong labels", () => {
    expect(() => buildRecord({ ...input, package: "channels" })).toThrow();
    expect(() => buildRecord({ ...input, dataClass: "test" as "real" })).toThrow();
    expect(() => buildRecord({ ...input, purpose: "x".repeat(201) })).toThrow();
  });

  it("floors fractional counts", () => {
    const record = buildRecord({ ...input, inputTokens: 10.7, latencyMs: 3.2 });
    expect(record.inputTokens).toBe(10);
    expect(record.latencyMs).toBe(3);
  });

  it("records through sinks", async () => {
    const sink = new MemorySink();
    const recorder = new UsageRecorder([sink]);
    await recorder.record(input);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].model).toBe("muse-spark-1.3");
  });

  it("estimates the contributor tier above zero", () => {
    expect(estimateCostUsd("muse-spark-1.3-contributor", 1000, 1000)).toBeGreaterThan(0);
    expect(estimateCostUsd("unknown-model", 1000, 1000)).toBe(0);
  });
});
