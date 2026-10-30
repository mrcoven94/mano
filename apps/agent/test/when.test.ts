import { describe, expect, it } from "vitest";

import { parseClock, parseWhen, validateDue } from "../agent/lib/when.js";

const TZ = "America/Denver";
// Thursday 2026-10-29 09:00 MDT (15:00 UTC).
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);

describe("parseClock", () => {
  it("parses clock times", () => {
    expect(parseClock("9")).toEqual([9, 0]);
    expect(parseClock("9:30pm")).toEqual([21, 30]);
    expect(parseClock("12am")).toEqual([0, 0]);
    expect(parseClock("12pm")).toEqual([12, 0]);
    expect(parseClock("21:15")).toEqual([21, 15]);
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("nine")).toBeNull();
  });
});

describe("parseWhen", () => {
  it("parses relative times", () => {
    expect(parseWhen("in 20 minutes", NOW, TZ)).toEqual({ dueAtMs: NOW + 20 * 60_000 });
    expect(parseWhen("in 2 hours", NOW, TZ)).toEqual({ dueAtMs: NOW + 2 * 3_600_000 });
    expect(parseWhen("in a week", NOW, TZ)).toEqual({ dueAtMs: NOW + 7 * 86_400_000 });
  });

  it("parses tomorrow and weekdays at 9am by default", () => {
    // Friday Oct 30 09:00 MDT = 15:00 UTC.
    const friday9 = Date.UTC(2026, 9, 30, 15, 0, 0);
    expect(parseWhen("tomorrow at 9", NOW, TZ)).toEqual({ dueAtMs: friday9 });
    expect(parseWhen("Friday", NOW, TZ)).toEqual({ dueAtMs: friday9 });
    expect(parseWhen("friday 9am", NOW, TZ)).toEqual({ dueAtMs: friday9 });
  });

  it("parses explicit clocks", () => {
    // Friday Oct 30 14:00 MDT = 20:00 UTC.
    expect(parseWhen("friday at 2pm", NOW, TZ)).toEqual({ dueAtMs: Date.UTC(2026, 9, 30, 20, 0, 0) });
    expect(parseWhen("tomorrow morning", NOW, TZ)).toEqual({ dueAtMs: Date.UTC(2026, 9, 30, 15, 0, 0) });
  });

  it("rolls a passed bare time to tomorrow", () => {
    // 09:00 today is exactly now, so "at 9" means tomorrow.
    expect(parseWhen("at 9", NOW, TZ)).toEqual({ dueAtMs: Date.UTC(2026, 9, 30, 15, 0, 0) });
    // 10:00 today is still ahead.
    expect(parseWhen("at 10", NOW, TZ)).toEqual({ dueAtMs: Date.UTC(2026, 9, 29, 16, 0, 0) });
  });

  it("crosses the DST boundary", () => {
    // "next friday" from Thu Oct 29 skips Oct 30 and lands Nov 6 09:00 MST = 16:00 UTC.
    expect(parseWhen("next friday", NOW, TZ)).toEqual({ dueAtMs: Date.UTC(2026, 10, 6, 16, 0, 0) });
  });

  it("rejects nonsense", () => {
    expect(parseWhen("someday", NOW, TZ)).toBeNull();
    expect(parseWhen("", NOW, TZ)).toBeNull();
    expect(parseWhen("tomorrow at nine", NOW, TZ)).toBeNull();
  });
});

describe("validateDue", () => {
  it("rejects past and far-future times", () => {
    expect(validateDue(NOW - 1, NOW)).toMatch(/already passed/);
    expect(validateDue(NOW + 367 * 86_400_000, NOW)).toMatch(/more than a year/);
    expect(validateDue(NOW + 1000, NOW)).toBeNull();
  });
});
