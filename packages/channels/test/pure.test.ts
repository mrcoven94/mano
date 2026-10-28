import { describe, expect, it } from "vitest";
import { splitBubbles } from "../src/bubbles.js";
import { isOptOut, parseApprovalReply } from "../src/approvals.js";
import {
  DEFAULT_DAILY_BUDGET_USD,
  HANDLE_DAILY_LIMIT,
  HANDLE_HOURLY_LIMIT,
  budgetAllows,
  dayKeyFor,
  estimateCostUsd,
  handleOverLimit,
  hourKeyFor,
} from "../src/limits.js";

describe("splitBubbles", () => {
  it("keeps short replies whole", () => {
    expect(splitBubbles("Hello there.")).toEqual(["Hello there."]);
  });

  it("splits at sentence boundaries", () => {
    const bubbles = splitBubbles("First sentence. Second sentence! Third one?", 4, 20);
    expect(bubbles.length).toBeGreaterThan(1);
    expect(bubbles.join(" ")).toBe("First sentence. Second sentence! Third one?");
  });

  it("caps the bubble count", () => {
    const text = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."].join(" ");
    expect(splitBubbles(text, 3, 10)).toHaveLength(3);
  });
});

describe("parseApprovalReply", () => {
  it("accepts YES and NO with a code", () => {
    expect(parseApprovalReply("YES abc123")).toEqual({ decision: "yes", code: "abc123" });
    expect(parseApprovalReply("no XYZ-9")).toEqual({ decision: "no", code: "XYZ-9" });
  });

  it("rejects anything else", () => {
    expect(parseApprovalReply("YES")).toBeNull();
    expect(parseApprovalReply("yess abc123")).toBeNull();
    expect(parseApprovalReply("MAYBE abc123")).toBeNull();
    expect(parseApprovalReply("YES abc123 extra")).toBeNull();
    // Lenient parse, strict match: "please" parses as a code, and the
    // runner only acts when it matches a pending approval.
    expect(parseApprovalReply("yes please")).toEqual({ decision: "yes", code: "please" });
  });
});

describe("isOptOut", () => {
  it("matches STOP-family keywords", () => {
    for (const word of ["STOP", "stop", "QUIT", "CANCEL", "UNSUBSCRIBE", "END"]) {
      expect(isOptOut(` ${word} `)).toBe(true);
    }
    expect(isOptOut("stop by later")).toBe(false);
    expect(isOptOut("do not stop")).toBe(false);
  });
});

describe("handleOverLimit", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");

  it("trips the hourly and daily caps", () => {
    const hour = { hourKey: hourKeyFor(now), hourCount: HANDLE_HOURLY_LIMIT, dayKey: dayKeyFor(now), dayCount: 1 };
    expect(handleOverLimit(hour, now)).toBe("hour");
    const day = { hourKey: hourKeyFor(now), hourCount: 1, dayKey: dayKeyFor(now), dayCount: HANDLE_DAILY_LIMIT };
    expect(handleOverLimit(day, now)).toBe("day");
  });

  it("resets when the window rolls", () => {
    const windows = { hourKey: hourKeyFor(now - 3600_000), hourCount: HANDLE_HOURLY_LIMIT, dayKey: dayKeyFor(now - 86400_000), dayCount: HANDLE_DAILY_LIMIT };
    expect(handleOverLimit(windows, now)).toBeNull();
  });
});

describe("budget", () => {
  it("converts chars to dollars and compares", () => {
    expect(DEFAULT_DAILY_BUDGET_USD).toBe(5);
    expect(estimateCostUsd(1000, 1000, 0.001)).toBeCloseTo(0.002);
    expect(budgetAllows(4.99, 0.02, 5)).toBe(false);
    expect(budgetAllows(4.0, 0.02, 5)).toBe(true);
  });
});
