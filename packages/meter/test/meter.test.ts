import { describe, expect, it } from "vitest";
import {
  AnalyticsEngineSink,
  JsonLinesSink,
  MAX_LABEL_LENGTH,
  MemorySink,
  MeterRecorder,
  NullSink,
  RECORD_KEYS,
  buildRecord,
  dayFileName,
  estimateCostUsd,
  formatLine,
  meterNamesFromEnv,
  parseLine,
  rateFor,
  recordToPoint,
  startCall,
  summarizeDay,
  summaryKey,
  uploadDailySummary,
  type AnalyticsEnginePoint,
  type UsageInput,
  type UsageRecord,
} from "../src/index.js";

function input(overrides: Partial<UsageInput> = {}): UsageInput {
  return {
    package: "channels",
    purpose: "answer-texts",
    provider: "meta",
    model: "muse-spark-1.3",
    dataClass: "real",
    inputTokens: 1000,
    outputTokens: 100,
    latencyMs: 250,
    status: "ok",
    ...overrides,
  };
}

describe("buildRecord", () => {
  it("builds a record with estimated cost and timestamp", () => {
    const record = buildRecord(input(), { at: "2026-10-29T00:00:00.000Z" });
    expect(record.package).toBe("channels");
    expect(record.estimatedCostUsd).toBe(estimateCostUsd("muse-spark-1.3", 1000, 100));
    expect(record.estimatedCostUsd).toBeGreaterThan(0);
    expect(record.at).toBe("2026-10-29T00:00:00.000Z");
    expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS].sort());
  });

  it("rejects unknown packages, data classes and statuses", () => {
    expect(() => buildRecord(input({ package: "portal" as never }))).toThrow("Unknown meter package");
    expect(() => buildRecord(input({ dataClass: "test" as never }))).toThrow("dataClass");
    expect(() => buildRecord(input({ status: "timeout" as never }))).toThrow("status");
  });

  it("rejects empty labels and labels long enough to smuggle content", () => {
    expect(() => buildRecord(input({ purpose: "" }))).toThrow("purpose");
    expect(() => buildRecord(input({ purpose: "x".repeat(MAX_LABEL_LENGTH + 1) }))).toThrow("short label");
  });

  it("rejects non-finite counts and floors fractions", () => {
    expect(() => buildRecord(input({ inputTokens: Number.NaN }))).toThrow("inputTokens");
    expect(buildRecord(input({ outputTokens: 99.9 })).outputTokens).toBe(99);
    expect(buildRecord(input({ latencyMs: -5 })).latencyMs).toBe(0);
  });
});

describe("rates", () => {
  it("estimates from the table in one file", () => {
    expect(estimateCostUsd("muse-spark-1.3", 1000, 1000)).toBe(0.0075);
  });

  it("prices stand-ins at zero and unknown models at the zero fallback", () => {
    expect(estimateCostUsd("stand-in", 5000, 5000)).toBe(0);
    expect(rateFor("some-future-model")).toEqual({ inputPer1kUsd: 0, outputPer1kUsd: 0 });
    expect(estimateCostUsd("some-future-model", 5000, 5000)).toBe(0);
  });

  it("lets a deploy override rates without editing code", () => {
    const cost = estimateCostUsd("muse-spark-1.3", 1000, 0, {
      "muse-spark-1.3": { inputPer1kUsd: 0.5, outputPer1kUsd: 0.5 },
    });
    expect(cost).toBe(0.5);
  });
});

describe("MeterRecorder", () => {
  it("fans one record out to every sink", async () => {
    const first = new MemorySink();
    const second = new MemorySink();
    const meter = new MeterRecorder([first]);
    meter.addSink(second);
    const record = await meter.record(input());
    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(first.records[0]).toEqual(record);
  });

  it("measures latency with startCall", async () => {
    let now = 1000;
    const elapsed = startCall(() => now);
    now += 321;
    const meter = new MeterRecorder();
    const record = await meter.record(input({ latencyMs: elapsed() }));
    expect(record.latencyMs).toBe(321);
  });

  it("drops records through the null sink without branching", async () => {
    const meter = new MeterRecorder([new NullSink()]);
    const record = await meter.record(input());
    expect(record.package).toBe("channels");
  });
});

describe("AnalyticsEngineSink", () => {
  it("maps the record onto blobs, doubles and indexes", () => {
    const points: AnalyticsEnginePoint[] = [];
    const sink = new AnalyticsEngineSink({ writeDataPoint: (p) => void points.push(p) });
    const record = buildRecord(input(), { at: "2026-10-29T00:00:00.000Z" });
    sink.write(record);
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual(recordToPoint(record));
    expect(points[0].blobs).toContain("muse-spark-1.3");
    expect(points[0].doubles).toEqual([1000, 100, 250, record.estimatedCostUsd]);
    expect(points[0].indexes).toEqual(["muse-spark-1.3"]);
  });

  it("reads dataset and bucket names from env with documented defaults", () => {
    expect(meterNamesFromEnv({})).toEqual({ analyticsDataset: "mano_model_usage", r2Bucket: "mano-meter", r2Prefix: "meter/" });
    expect(meterNamesFromEnv({ METER_R2_BUCKET: "other", METER_R2_PREFIX: "m" })).toEqual({
      analyticsDataset: "mano_model_usage",
      r2Bucket: "other",
      r2Prefix: "m/",
    });
  });
});

describe("JSON lines sink", () => {
  it("writes one line per record to the day file", async () => {
    const writes: Array<{ path: string; line: string }> = [];
    const sink = new JsonLinesSink({
      dir: "/tmp/meter-test",
      day: "2026-10-29",
      appendLine: (path, line) => void writes.push({ path, line }),
    });
    expect(sink.path()).toBe("/tmp/meter-test/usage-2026-10-29.jsonl");
    expect(dayFileName("2026-10-29")).toBe("usage-2026-10-29.jsonl");
    const record = buildRecord(input());
    await sink.write(record);
    expect(writes).toHaveLength(1);
    expect(parseLine(writes[0].line.trim())).toEqual(record);
    expect(formatLine(record)).toBe(JSON.stringify(record));
  });

  it("summarizes a day by package and model", () => {
    const records = [
      buildRecord(input({})),
      buildRecord(input({ package: "mail", status: "error", inputTokens: 10, outputTokens: 0 })),
      buildRecord(input({ model: "stand-in", inputTokens: 5, outputTokens: 5 })),
    ];
    const summary = summarizeDay(records, "2026-10-29");
    expect(summary.day).toBe("2026-10-29");
    expect(summary.totals.calls).toBe(3);
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.inputTokens).toBe(1015);
    expect(summary.byPackage.mail.errors).toBe(1);
    expect(summary.byModel["stand-in"].calls).toBe(1);
    expect(summary.byModel["stand-in"].estimatedCostUsd).toBe(0);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(records[0].estimatedCostUsd + records[1].estimatedCostUsd, 8);
  });

  it("uploads the daily summary to the meter bucket and returns the key", async () => {
    const puts: Array<{ key: string; body: string }> = [];
    const summary = summarizeDay([buildRecord(input())], "2026-10-29");
    const key = await uploadDailySummary({ put: async (k, b) => void puts.push({ key: k, body: String(b) }) }, summary);
    expect(key).toBe("meter/daily/2026-10-29.json");
    expect(summaryKey("meter/", "2026-10-29")).toBe(key);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0].body).day).toBe("2026-10-29");
  });
});

describe("sentinel: no record ever contains content", () => {
  // Unique markers stand in for prompt, answer, person ID, phone and
  // content. They are smuggled onto the input object under every field
  // name a careless caller or a spread could use; every written form of
  // every record is then searched for every marker.
  const SENTINELS = [
    "SENTINEL-PROMPT-a4f9c2",
    "SENTINEL-ANSWER-b7e1d8",
    "SENTINEL-PERSON-c3f6a1",
    "SENTINEL-PHONE-+1-555-010-9283",
    "SENTINEL-CONTENT-e9d2b4",
    "SENTINEL-SSN-987-65-4320",
  ] as const;

  function poisoned(): UsageInput {
    return {
      ...input(),
      prompt: `answer this: ${SENTINELS[0]}`,
      answer: SENTINELS[1],
      personId: SENTINELS[2],
      phone: SENTINELS[3],
      content: SENTINELS[4],
      ssn: SENTINELS[5],
      messages: [{ role: "user", content: SENTINELS[0] }],
      history: [SENTINELS[1], SENTINELS[4]],
    } as unknown as UsageInput;
  }

  it("drops every smuggled field from records, lines and analytics points", async () => {
    const memory = new MemorySink();
    const points: AnalyticsEnginePoint[] = [];
    const analytics = new AnalyticsEngineSink({ writeDataPoint: (p) => void points.push(p) });
    const lines: string[] = [];
    const jsonl = new JsonLinesSink({ dir: "/tmp/meter-test", day: "2026-10-29", appendLine: (_p, line) => void lines.push(line) });
    const meter = new MeterRecorder([memory, analytics, jsonl]);

    await meter.record(poisoned());
    await meter.record(poisoned());

    expect(memory.records).toHaveLength(2);
    expect(points).toHaveLength(2);
    expect(lines).toHaveLength(2);

    const written: string[] = [];
    for (const record of memory.records) {
      expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS].sort());
      written.push(JSON.stringify(record));
    }
    for (const point of points) written.push(JSON.stringify(point));
    for (const line of lines) {
      expect(Object.keys(parseLine(line.trim())).sort()).toEqual([...RECORD_KEYS].sort());
      written.push(line);
    }
    const summary = summarizeDay(memory.records, "2026-10-29");
    let uploaded = "";
    await uploadDailySummary({ put: async (_k, b) => void (uploaded = String(b)) }, summary);
    written.push(uploaded);

    const haystack = written.join("\n");
    for (const sentinel of SENTINELS) {
      expect(haystack).not.toContain(sentinel);
    }
  });
});
