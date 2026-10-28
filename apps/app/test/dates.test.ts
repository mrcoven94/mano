import { describe, expect, it } from "vitest";
import { daysUntil, formatDate } from "../lib/dates";

describe("dates", () => {
  it("counts whole days up", () => {
    const now = new Date("2026-10-28T12:00:00.000Z").getTime();
    expect(daysUntil("2026-10-28T18:00:00.000Z", now)).toBe(0);
    expect(daysUntil("2026-10-29T09:00:00.000Z", now)).toBe(1);
    expect(daysUntil("2026-11-15T17:00:00.000Z", now)).toBe(18);
    expect(daysUntil("2026-10-27T12:00:00.000Z", now)).toBe(-1);
  });

  it("formats short dates per language", () => {
    expect(formatDate("2026-11-15T17:00:00.000Z", "en")).toContain("2026");
    expect(formatDate("2026-11-15T17:00:00.000Z", "es")).toContain("2026");
    expect(formatDate("not-a-date", "en")).toBe("not-a-date");
  });
});
