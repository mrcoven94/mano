// Tests for the /stats aggregations. Unit cases build records through
// the real buildRecord (never hand-shaped cost math), and the file
// cases load the checked-in site snapshots and assert they are
// internally consistent.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { buildRecord, type UsageInput, type UsageRecord } from "../src/record.js";
import { estimateCostUsd } from "../src/rates.js";
import { parseLine, summarizeDay } from "../src/jsonl.js";
import {
  filterRecordsSince,
  percentile,
  sinceDayForWindow,
  summarizeHistory,
  summarizeSessions,
  summarizeUsage,
  type HistoryFile,
} from "../src/stats.js";

const DATA_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../apps/site/data");

function record(over: Partial<UsageInput> & { at?: string; latencyMs?: number }): UsageRecord {
  const { at, ...input } = over;
  const built = buildRecord(
    {
      package: "channels",
      purpose: "answer-texts",
      provider: "meta",
      model: "muse-spark-1.3",
      dataClass: "synthetic",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 10,
      status: "ok",
      ...input,
    },
    at ? { at } : {},
  );
  return built;
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
  it("splits Meta share, models, cost and latency", () => {
    const records = [
      record({ inputTokens: 100, outputTokens: 20, latencyMs: 10 }),
      record({ inputTokens: 300, outputTokens: 60, latencyMs: 30 }),
      record({ provider: "stand-in", model: "stand-in", inputTokens: 40, outputTokens: 40, latencyMs: 0 }),
    ];
    const summary = summarizeUsage(records);
    expect(summary.calls).toBe(3);
    expect(summary.errors).toBe(0);
    expect(summary.tokens).toBe(560);
    expect(summary.metaCalls).toBe(2);
    expect(summary.metaCallShare).toBeCloseTo(2 / 3, 10);
    expect(summary.metaTokenShare).toBeCloseTo(480 / 560, 10);
    expect(summary.byModel.map((r) => r.model)).toEqual(["muse-spark-1.3", "stand-in"]);
    expect(summary.byModel[0]).toMatchObject({ calls: 2, tokens: 480 });
    expect(summary.byModel[1]).toMatchObject({ calls: 1, tokens: 80, estimatedCostUsd: 0 });
    expect(summary.estimatedCostUsd).toBe(
      estimateCostUsd("muse-spark-1.3", 400, 80),
    );
    expect(summary.latencyP50Ms).toBe(10);
    expect(summary.latencyP95Ms).toBe(30);
  });

  it("counts errors and keeps production separate from test traffic", () => {
    const records = [
      record({ status: "error", outputTokens: 0, dataClass: "real" }),
      record({ provider: "stand-in", model: "stand-in", dataClass: "real" }),
      record({ dataClass: "synthetic" }),
    ];
    const summary = summarizeUsage(records);
    expect(summary.errors).toBe(1);
    expect(summary.productionCalls).toBe(2);
    expect(summary.productionMetaCallShare).toBeCloseTo(1 / 2, 10);
    expect(summary.productionMetaTokenShare).toBeCloseTo(100 / 220, 10);
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
    const synthetic = summarizeUsage([record({ dataClass: "synthetic" })]);
    expect(synthetic.productionCalls).toBe(0);
    expect(synthetic.productionMetaCallShare).toBeNull();
    expect(synthetic.range).toEqual({ from: synthetic.range!.from, to: synthetic.range!.from });
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

describe("checked-in snapshots", () => {
  it("usage summary matches the checked-in usage lines", () => {
    const usage = JSON.parse(readFileSync(path.join(DATA_DIR, "usage.json"), "utf8")) as UsageRecord[];
    expect(usage.length).toBeGreaterThan(0);
    const summary = summarizeUsage(usage);
    expect(summary.calls).toBe(usage.length);
    expect(summary.range).not.toBeNull();
    const daySummary = JSON.parse(readFileSync(path.join(DATA_DIR, "usage-summary.json"), "utf8"));
    expect(daySummary).toEqual(summarizeDay(usage, summary.range!.from));
    const jsonl = readFileSync(path.join(DATA_DIR, `usage-${summary.range!.from}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map(parseLine);
    expect(jsonl).toEqual(usage);
  });

  it("history snapshot is internally consistent", () => {
    const history = JSON.parse(readFileSync(path.join(DATA_DIR, "history.json"), "utf8")) as HistoryFile;
    expect(history.repo).toBe("mrcoven94/mano");
    expect(history.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const numbers = history.prs.map((pr) => pr.number);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    for (const pr of history.prs) {
      expect(Object.keys(pr).sort()).toEqual(
        ["comments", "formalReviews", "mergedDay", "multiModelReviews", "number", "openToMergeSeconds", "openedDay", "ownerComments", "reviewRounds", "session", "state"].sort(),
      );
      expect(pr.mergedDay === null).toBe(pr.openToMergeSeconds === null);
    }
    // Day buckets and session rows fold the same PRs, so the review
    // totals agree three ways.
    const summary = summarizeHistory(history);
    expect(summary.prsMerged).toBeGreaterThan(0);
    expect(summary.reviewRounds).toBe(history.prs.reduce((n, pr) => n + pr.reviewRounds, 0));
    expect(summary.reviewRounds).toBe(
      Object.values(history.sessions).reduce((n, s) => n + s.reviewRounds, 0),
    );
    const dayOpened = Object.values(history.days).reduce((n, d) => n + d.prsOpened, 0);
    expect(dayOpened).toBe(history.prs.length);
    expect(summary.museLineShare).toBeGreaterThanOrEqual(0);
    expect(summary.museLineShare).toBeLessThanOrEqual(1);
  });
});
