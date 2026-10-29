// Tests for the nightly Analytics Engine export. Canned AE rows stand
// in for the SQL API (no network); the parity cases fail if the export
// drifts from the recorder's own key orders.
import { describe, expect, it } from "vitest";
import { POINT_BLOB_KEYS, POINT_DOUBLE_KEYS } from "../src/analytics.js";
import { RECORD_KEYS, buildRecord } from "../src/record.js";
import {
  AE_BLOB_KEYS,
  AE_DOUBLE_KEYS,
  AE_RECORD_KEYS,
  EXPORT_LIMIT,
  buildUsageIndex,
  buildUsageQuery,
  groupByDay,
  rowToRecord,
  rowsToDayFiles,
} from "../history/ae-export.mjs";

function aeRow(over = {}) {
  return {
    blob1: "channels",
    blob2: "answer-texts",
    blob3: "meta",
    blob4: "muse-spark-1.3",
    blob5: "real",
    blob6: "production",
    blob7: "ok",
    blob8: "2026-10-29T01:02:03.000Z",
    double1: 100,
    double2: 20,
    double3: 12,
    double4: 250,
    double5: 0.00027,
    ...over,
  };
}

describe("column layout parity", () => {
  it("mirrors the recorder's blob, double and record orders", () => {
    expect(AE_BLOB_KEYS).toEqual([...POINT_BLOB_KEYS]);
    expect(AE_DOUBLE_KEYS).toEqual([...POINT_DOUBLE_KEYS]);
    expect(AE_RECORD_KEYS).toEqual([...RECORD_KEYS]);
  });

  it("round-trips a record through a point and back", () => {
    const record = buildRecord(
      {
        package: "channels",
        purpose: "answer-texts",
        provider: "meta",
        model: "muse-spark-1.3",
        dataClass: "real",
        environment: "production",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 12,
        latencyMs: 250,
        status: "ok",
      },
      { at: "2026-10-29T01:02:03.000Z" },
    );
    // Point positions feed the export query, so the row below is built
    // the way the SQL API returns one.
    const row = {};
    POINT_BLOB_KEYS.forEach((key, i) => {
      row[`blob${i + 1}`] = record[key];
    });
    POINT_DOUBLE_KEYS.forEach((key, i) => {
      row[`double${i + 1}`] = record[key];
    });
    expect(rowToRecord(row)).toEqual({ ...record });
  });
});

describe("buildUsageQuery", () => {
  it("selects every column for the day window", () => {
    const query = buildUsageQuery("mano_model_usage", 90);
    expect(query).toContain("FROM mano_model_usage");
    expect(query).toContain("now() - INTERVAL '90' DAY");
    expect(query.startsWith("SELECT timestamp, ")).toBe(true);
    expect(query).toContain(`LIMIT ${EXPORT_LIMIT}`);
    for (let i = 1; i <= 8; i += 1) expect(query).toContain(`blob${i}`);
    for (let i = 1; i <= 5; i += 1) expect(query).toContain(`double${i}`);
  });

  it("refuses datasets and day counts outside the tight shapes", () => {
    expect(() => buildUsageQuery("mano_model_usage; DROP", 90)).toThrow("Refusing to query");
    expect(() => buildUsageQuery("mano_model_usage", 0)).toThrow("days");
    expect(() => buildUsageQuery("mano_model_usage", 366)).toThrow("days");
  });
});

describe("rowToRecord", () => {
  it("maps a row back to record shape", () => {
    expect(rowToRecord(aeRow())).toEqual({
      package: "channels",
      purpose: "answer-texts",
      provider: "meta",
      model: "muse-spark-1.3",
      dataClass: "real",
      environment: "production",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 12,
      latencyMs: 250,
      status: "ok",
      estimatedCostUsd: 0.00027,
      at: "2026-10-29T01:02:03.000Z",
    });
  });

  it("drops malformed rows instead of writing them", () => {
    expect(rowToRecord(null)).toBeNull();
    expect(rowToRecord(aeRow({ blob4: "" }))).toBeNull();
    expect(rowToRecord(aeRow({ blob4: 7 }))).toBeNull();
    expect(rowToRecord(aeRow({ double1: "100" }))).toBeNull();
    expect(rowToRecord(aeRow({ double5: Number.NaN }))).toBeNull();
    expect(rowToRecord(aeRow({ blob8: "yesterday" }))).toBeNull();
  });
});

describe("rowsToDayFiles", () => {
  it("groups rows by UTC day with sorted JSON lines", () => {
    const { files, skippedRows, truncated } = rowsToDayFiles([
      aeRow({ blob8: "2026-10-30T00:00:01.000Z" }),
      aeRow({ blob8: "2026-10-29T23:59:59.000Z" }),
      aeRow({ blob8: "2026-10-29T00:00:00.000Z", double1: "bad" }),
    ]);
    expect(skippedRows).toBe(1);
    expect(truncated).toBe(false);
    expect(files.map((f) => f.day)).toEqual(["2026-10-29", "2026-10-30"]);
    const lines = files[0].jsonl.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed)).toEqual([...AE_RECORD_KEYS]);
    // Exported lines re-validate through the recorder unchanged.
    expect(buildRecord(parsed, { at: parsed.at }).model).toBe("muse-spark-1.3");
  });

  it("flags truncation at the row cap", () => {
    const rows = Array.from({ length: EXPORT_LIMIT }, () => aeRow());
    expect(rowsToDayFiles(rows).truncated).toBe(true);
  });
});

describe("groupByDay", () => {
  it("sorts days ascending", () => {
    const files = groupByDay([{ at: "2026-10-30T00:00:00.000Z" }, { at: "2026-10-28T00:00:00.000Z" }]);
    expect(files.map((f) => f.day)).toEqual(["2026-10-28", "2026-10-30"]);
  });
});

describe("buildUsageIndex", () => {
  it("carries days, skips and truncation", () => {
    expect(
      buildUsageIndex(["2026-10-29"], {
        generatedAt: "2026-10-30T06:00:00.000Z",
        dataset: "mano_model_usage",
        skippedRows: 2,
        truncated: false,
      }),
    ).toEqual({
      generatedAt: "2026-10-30T06:00:00.000Z",
      dataset: "mano_model_usage",
      days: ["2026-10-29"],
      skippedRows: 2,
      truncated: false,
    });
  });
});
