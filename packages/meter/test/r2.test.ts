// Tests for the R2 stats loader. An injected fetch stands in for the
// bucket (no network); every payload passes through buildRecord, so a
// line the recorder would reject never reaches the page.
import { describe, expect, it } from "vitest";
import { buildRecord } from "../src/record.js";
import { formatLine } from "../src/jsonl.js";
import { loadStatsFromR2 } from "../src/r2.js";

const BASE = "https://meter.example.com";

function recordLine(over: Record<string, unknown> = {}, at = "2026-10-29T01:00:00.000Z"): string {
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
      ...over,
    },
    { at },
  );
  return formatLine(record);
}

function historyPayload(): Record<string, unknown> {
  return {
    generatedAt: "2026-10-30T06:00:00.000Z",
    repo: "mrcoven94/mano",
    days: {},
    sessions: {},
    prs: [],
  };
}

function stubFetch(files: Record<string, string>): typeof fetch {
  return (async (url: unknown) => {
    const key = String(url).slice(BASE.length + 1);
    const body = files[key];
    if (body === undefined) return new Response("no such key", { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe("loadStatsFromR2", () => {
  it("loads indexed days plus the latest history", async () => {
    const fetchImpl = stubFetch({
      "meter/usage/index.json": JSON.stringify({
        generatedAt: "2026-10-30T06:00:00.000Z",
        dataset: "mano_model_usage",
        days: ["2026-10-29", "2026-10-30"],
        truncated: false,
      }),
      "meter/usage/records/2026-10-29.jsonl": `${recordLine()}\n${recordLine({ status: "error", outputTokens: 0, reasoningTokens: 0 }, "2026-10-29T02:00:00.000Z")}\n`,
      "meter/usage/records/2026-10-30.jsonl": `${recordLine({}, "2026-10-30T01:00:00.000Z")}\n`,
      "meter/history/latest.json": JSON.stringify(historyPayload()),
    });
    const load = await loadStatsFromR2({ baseUrl: BASE, days: null, fetchImpl });
    expect(load.indexedDays).toEqual(["2026-10-29", "2026-10-30"]);
    expect(load.records).toHaveLength(3);
    expect(load.records.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(load.records[0].environment).toBe("production");
    expect(load.records[0].reasoningTokens).toBe(12);
    expect(load.skippedLines).toBe(0);
    expect(load.usageTruncated).toBe(false);
    expect(load.history?.repo).toBe("mrcoven94/mano");
  });

  it("fetches explicit days without the index, skipping missing ones", async () => {
    const fetchImpl = stubFetch({
      "meter/usage/records/2026-10-29.jsonl": `${recordLine()}\n`,
    });
    const load = await loadStatsFromR2({ baseUrl: BASE, days: ["2026-10-29", "2026-10-30", "not-a-day"], fetchImpl });
    expect(load.indexedDays).toBeNull();
    expect(load.records).toHaveLength(1);
    expect(load.history).toBeNull();
  });

  it("skips malformed lines and counts them, never rendering them", async () => {
    const fetchImpl = stubFetch({
      "meter/usage/records/2026-10-29.jsonl": [
        recordLine(),
        "this is not json",
        JSON.stringify({ package: "channels", purpose: "free text content here", provider: "meta" }),
        "",
      ].join("\n"),
    });
    const load = await loadStatsFromR2({ baseUrl: BASE, days: ["2026-10-29"], fetchImpl });
    expect(load.records).toHaveLength(1);
    expect(load.skippedLines).toBe(2);
  });

  it("treats a missing index or corrupt history as absent", async () => {
    const missing = await loadStatsFromR2({ baseUrl: BASE, days: null, fetchImpl: stubFetch({}) });
    expect(missing).toMatchObject({ records: [], history: null, indexedDays: null });
    const corrupt = await loadStatsFromR2({
      baseUrl: BASE,
      days: [],
      fetchImpl: stubFetch({ "meter/history/latest.json": JSON.stringify({ repo: "x" }) }),
    });
    expect(corrupt.history).toBeNull();
  });

  it("rejects non-http bases and surfaces failed reads", async () => {
    await expect(loadStatsFromR2({ baseUrl: "ftp://x", days: [] })).rejects.toThrow("http(s)");
    const failing = (() => Promise.resolve(new Response("err", { status: 500 }))) as typeof fetch;
    await expect(loadStatsFromR2({ baseUrl: BASE, days: ["2026-10-29"], fetchImpl: failing })).rejects.toThrow("500");
  });
});
