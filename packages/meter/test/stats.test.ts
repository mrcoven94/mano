// Tests for the /stats aggregations. Unit cases build records through
// the real buildRecord (never hand-shaped cost math), and the loader
// cases prove R2 lines round-trip back into identical summaries.
import { describe, expect, it } from "vitest";
import { buildRecord, type UsageInput, type UsageRecord } from "../src/record.js";
import { estimateCostUsd } from "../src/rates.js";
import { formatLine, parseLine } from "../src/jsonl.js";
import {
  daysForWindow,
  filterRecordsSince,
  isHistoryFile,
  percentile,
  sinceDayForWindow,
  summarizeHistory,
  summarizeSessions,
  summarizeUsage,
  type HistoryFile,
} from "../src/stats.js";

function record(over: Partial<UsageInput> & { at?: string }): UsageRecord {
  const { at, ...input } = over;
  return buildRecord(
    {
      package: "channels",
      purpose: "answer-texts",
      provider: "meta",
      model: "muse-spark-1.3",
      dataClass: "synthetic",
      environment: "local",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 12,
      latencyMs: 10,
      status: "ok",
      ...input,
    },
    at ? { at } : {},
  );
}

describe("percentile", () => {
  it("returns null for no values", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("uses nearest rank", () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([5], 95)).toBe(5);
  });
});

describe("summarizeUsage", () => {
  it("splits Meta share, models, cost and latency over model calls only", () => {
    const records = [
      record({ inputTokens: 100, outputTokens: 20, reasoningTokens: 12, latencyMs: 10 }),
      record({ inputTokens: 300, outputTokens: 60, reasoningTokens: 40, latencyMs: 30 }),
      record({ provider: "stand-in", model: "stand-in", inputTokens: 40, outputTokens: 40, reasoningTokens: 0, latencyMs: 0 }),
    ];
    const summary = summarizeUsage(records);
    expect(summary.calls).toBe(3);
    expect(summary.errors).toBe(0);
    expect(summary.tokens).toBe(560);
    expect(summary.reasoningTokens).toBe(52);
    expect(summary.metaCalls).toBe(2);
    expect(summary.testDoubleCalls).toBe(1);
    // The stand-in answered without calling a model, so it is out of
    // both Meta denominators.
    expect(summary.metaCallShare).toBe(1);
    expect(summary.metaTokenShare).toBe(1);
    expect(summary.byModel.map((r) => r.model)).toEqual(["muse-spark-1.3", "stand-in"]);
    expect(summary.byModel[0]).toMatchObject({ calls: 2, tokens: 480, reasoningTokens: 52 });
    expect(summary.byModel[1]).toMatchObject({ calls: 1, tokens: 80, estimatedCostUsd: 0 });
    expect(summary.estimatedCostUsd).toBe(
      estimateCostUsd("muse-spark-1.3", 400, 80),
    );
    expect(summary.latencyP50Ms).toBe(10);
    expect(summary.latencyP95Ms).toBe(30);
  });

  it("counts production by environment, never by data class", () => {
    const records = [
      record({ status: "error", outputTokens: 0, reasoningTokens: 0, dataClass: "real", environment: "local" }),
      record({ provider: "stand-in", model: "stand-in", dataClass: "real", environment: "production" }),
      record({ dataClass: "synthetic", environment: "production" }),
    ];
    const summary = summarizeUsage(records);
    expect(summary.errors).toBe(1);
    // The real-but-local error is not production; the synthetic-but-
    // production record is.
    expect(summary.productionCalls).toBe(2);
    expect(summary.productionMetaCallShare).toBe(1);
    expect(summary.productionMetaTokenShare).toBe(1);
  });

  it("feeds latency percentiles from answered calls only", () => {
    const records = [
      record({ latencyMs: 10 }),
      record({ latencyMs: 30 }),
      record({ status: "error", latencyMs: 5000, outputTokens: 0, reasoningTokens: 0 }),
    ];
    const summary = summarizeUsage(records);
    expect(summary.latencyP50Ms).toBe(10);
    expect(summary.latencyP95Ms).toBe(30);
  });

  it("reports null shares and latencies when there is nothing to share", () => {
    const summary = summarizeUsage([]);
    expect(summary.calls).toBe(0);
    expect(summary.metaCallShare).toBeNull();
    expect(summary.metaTokenShare).toBeNull();
    expect(summary.latencyP50Ms).toBeNull();
    expect(summary.latencyP95Ms).toBeNull();
    expect(summary.productionCalls).toBe(0);
    expect(summary.productionMetaCallShare).toBeNull();
    expect(summary.range).toBeNull();
    const local = summarizeUsage([record({ environment: "local" })]);
    expect(local.productionCalls).toBe(0);
    expect(local.productionMetaCallShare).toBeNull();
    expect(local.range).toEqual({ from: local.range!.from, to: local.range!.from });
    const doublesOnly = summarizeUsage([
      record({ provider: "stand-in", model: "stand-in", environment: "production" }),
    ]);
    expect(doublesOnly.productionCalls).toBe(1);
    expect(doublesOnly.productionMetaCallShare).toBeNull();
  });
});

describe("filterRecordsSince", () => {
  it("keeps the cutoff day and drops earlier days", () => {
    const records = [
      record({ at: "2026-10-27T12:00:00.000Z" }),
      record({ at: "2026-10-28T12:00:00.000Z" }),
      record({ at: "2026-10-29T12:00:00.000Z" }),
    ];
    expect(filterRecordsSince(records, null)).toHaveLength(3);
    expect(filterRecordsSince(records, "2026-10-28")).toHaveLength(2);
    expect(filterRecordsSince(records, "2026-10-30")).toHaveLength(0);
  });

  it("computes a last-N-days cutoff in UTC", () => {
    expect(sinceDayForWindow(7, new Date("2026-10-29T03:00:00.000Z"))).toBe("2026-10-23");
    expect(sinceDayForWindow(1, new Date("2026-10-29T03:00:00.000Z"))).toBe("2026-10-29");
  });

  it("lists the explicit days in a window", () => {
    expect(daysForWindow(1, new Date("2026-10-29T03:00:00.000Z"))).toEqual(["2026-10-29"]);
    expect(daysForWindow(3, new Date("2026-10-29T03:00:00.000Z"))).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
  });
});

describe("isHistoryFile", () => {
  const file: HistoryFile = {
    generatedAt: "2026-10-29T00:00:00.000Z",
    repo: "example/mano",
    days: {},
    sessions: {},
    prs: [],
  };

  it("accepts the collector shape and rejects anything else", () => {
    expect(isHistoryFile(file)).toBe(true);
    expect(isHistoryFile({ ...file, generatedAt: null })).toBe(true);
    expect(isHistoryFile(null)).toBe(false);
    expect(isHistoryFile([])).toBe(false);
    expect(isHistoryFile({ ...file, prs: {} })).toBe(false);
    expect(isHistoryFile({ ...file, days: null })).toBe(false);
    expect(isHistoryFile({ ...file, repo: 7 })).toBe(false);
  });
});

describe("summarizeHistory", () => {
  const file: HistoryFile = {
    generatedAt: "2026-10-29T00:00:00.000Z",
    repo: "example/mano",
    days: {
      "2026-10-28": {
        commits: { "muse-code": 1, architect: 0, person: 1 },
        lines: { "muse-code": 100, architect: 0, person: 300 },
        prsOpened: 2,
        prsMerged: 1,
      },
      "2026-10-29": {
        commits: { "muse-code": 0, architect: 1, person: 0 },
        lines: { "muse-code": 0, architect: 50, person: 0 },
        prsOpened: 1,
        prsMerged: 1,
      },
    },
    sessions: {
      Channels: {
        commits: { "muse-code": 1, architect: 0, person: 0 },
        lines: { "muse-code": 100, architect: 0, person: 0 },
        prsOpened: 1,
        prsMerged: 1,
        reviewRounds: 4,
        multiModelReviews: 4,
        openToMergeSeconds: { count: 1, total: 3600, avg: 3600 },
      },
    },
    prs: [
      {
        number: 1,
        session: "Channels",
        state: "MERGED",
        openedDay: "2026-10-28",
        mergedDay: "2026-10-28",
        openToMergeSeconds: 3600,
        comments: 5,
        ownerComments: 4,
        reviewRounds: 4,
        multiModelReviews: 4,
        formalReviews: { approved: 0, changesRequested: 0, commented: 0, dismissed: 0 },
      },
      {
        number: 2,
        session: "unprefixed",
        state: "OPEN",
        openedDay: "2026-10-29",
        mergedDay: null,
        openToMergeSeconds: null,
        comments: 0,
        ownerComments: 0,
        reviewRounds: 0,
        multiModelReviews: 0,
        formalReviews: { approved: 0, changesRequested: 0, commented: 0, dismissed: 0 },
      },
    ],
  };

  it("adds up classes, rounds and merge timing", () => {
    const summary = summarizeHistory(file);
    expect(summary.prsOpened).toBe(3);
    expect(summary.prsMerged).toBe(2);
    expect(summary.reviewRounds).toBe(4);
    expect(summary.multiModelReviews).toBe(4);
    expect(summary.commits).toBe(3);
    expect(summary.lines).toBe(450);
    expect(summary.museCommitShare).toBeCloseTo(1 / 3, 10);
    expect(summary.museLineShare).toBeCloseTo(100 / 450, 10);
    expect(summary.avgOpenToMergeSeconds).toBe(3600);
    expect(summary.mergedWithTiming).toBe(1);
    expect(summary.range).toEqual({ from: "2026-10-28", to: "2026-10-29" });
  });

  it("filters days and PRs by the same cutoff", () => {
    const summary = summarizeHistory(file, "2026-10-29");
    expect(summary.prsOpened).toBe(1);
    expect(summary.reviewRounds).toBe(0);
    expect(summary.lines).toBe(50);
    expect(summary.museLineShare).toBe(0);
    expect(summary.avgOpenToMergeSeconds).toBeNull();
    expect(summary.range).toEqual({ from: "2026-10-29", to: "2026-10-29" });
  });

  it("lists sessions by lines changed", () => {
    expect(summarizeSessions(file)).toEqual([
      { session: "Channels", commits: 1, lines: 100, prsMerged: 1, reviewRounds: 4, multiModelReviews: 4 },
    ]);
  });
});

describe("R2 round trip", () => {
  it("formats, parses and re-validates lines into identical summaries", () => {
    const direct = [
      record({ at: "2026-10-29T01:00:00.000Z" }),
      record({ provider: "stand-in", model: "stand-in", at: "2026-10-29T02:00:00.000Z" }),
    ];
    const reloaded = direct.map((r) => {
      const parsed = parseLine(formatLine(r));
      return buildRecord(parsed, { at: parsed.at });
    });
    expect(reloaded).toEqual(direct);
    expect(summarizeUsage(reloaded)).toEqual(summarizeUsage(direct));
  });
});
