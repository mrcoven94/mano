import { describe, expect, it } from "vitest";
import { findAmbiguousDate, parseAllDates, parseWrittenDate, resolveDeadline } from "../src/dates.js";

describe("parseWrittenDate", () => {
  it("parses full written dates", () => {
    expect(parseWrittenDate("November 20, 2026")).toBe("2026-11-20");
    expect(parseWrittenDate("by November 20, 2026.")).toBe("2026-11-20");
  });
  it("parses abbreviations and missing commas", () => {
    expect(parseWrittenDate("Nov 20 2026")).toBe("2026-11-20");
    expect(parseWrittenDate("Sept. 3, 2026")).toBe("2026-09-03");
  });
  it("parses day-first dates", () => {
    expect(parseWrittenDate("20 November 2026")).toBe("2026-11-20");
  });
  it("parses numeric and ISO dates", () => {
    expect(parseWrittenDate("11/20/2026")).toBe("2026-11-20");
    expect(parseWrittenDate("2026-11-20")).toBe("2026-11-20");
  });
  it("refuses numerics that read two ways", () => {
    expect(parseWrittenDate("03/04/2027")).toBeNull();
    expect(parseWrittenDate("13/04/2027")).toBeNull();
  });
  it("rejects impossible dates", () => {
    expect(parseWrittenDate("February 30, 2026")).toBeNull();
    expect(parseWrittenDate("no date here")).toBeNull();
  });
  it("returns the first date in reading order", () => {
    expect(parseWrittenDate("Notice date 11/22/2026, due November 20, 2026")).toBe("2026-11-22");
  });
});

describe("resolveDeadline", () => {
  it("passes absolute dates through", () => {
    expect(resolveDeadline("November 20, 2026", null)).toEqual({ kind: "absolute", iso: "2026-11-20" });
    expect(resolveDeadline(null, null)).toEqual({ kind: "none" });
    expect(resolveDeadline("no date here", null)).toEqual({ kind: "none" });
  });
  it("counts calendar days from an explicit anchor", () => {
    expect(resolveDeadline("within 10 days of November 25, 2026", null)).toEqual({
      kind: "relative",
      iso: "2026-12-05",
      anchorIso: "2026-11-25",
      anchorText: "November 25, 2026",
      anchorSource: "expression",
      count: 10,
      countRule: "calendar days",
    });
  });
  it("anchors to the notice date when the expression says so", () => {
    expect(resolveDeadline("60 days from the date of this notice", "November 5, 2026")).toEqual({
      kind: "relative",
      iso: "2027-01-04",
      anchorIso: "2026-11-05",
      anchorText: "the date of this notice",
      anchorSource: "notice-date",
      count: 60,
      countRule: "calendar days",
    });
  });
  it("counts business days skipping weekends", () => {
    // November 25, 2026 is a Wednesday; 10 business days lands December 9.
    const r = resolveDeadline("10 business days after November 25, 2026", null);
    expect(r).toMatchObject({ kind: "relative", iso: "2026-12-09", countRule: "business days" });
  });
  it("asks when the anchor is missing or unclear", () => {
    expect(resolveDeadline("within 10 days", "November 5, 2026").kind).toBe("needs-anchor");
    expect(resolveDeadline("within 10 days of receipt", "November 5, 2026").kind).toBe("needs-anchor");
    expect(resolveDeadline("60 days from the date of this notice", null).kind).toBe("needs-anchor");
  });
  it("never promotes the anchor date to the deadline", () => {
    const r = resolveDeadline("within 10 days of November 25, 2026", null);
    expect(r.kind === "relative" && r.iso).not.toBe("2026-11-25");
  });
  it("flags ambiguous dates instead of resolving them", () => {
    expect(resolveDeadline("due 03/04/2027", null)).toEqual({ kind: "ambiguous", expression: "03/04/2027" });
    expect(resolveDeadline("due January 5", null)).toEqual({ kind: "ambiguous", expression: "January 5" });
    expect(resolveDeadline("due November 20, 2026", null).kind).toBe("absolute");
  });
});

describe("findAmbiguousDate", () => {
  it("finds two-way numerics and yearless dates", () => {
    expect(findAmbiguousDate("due 03/04/2027")).toBe("03/04/2027");
    expect(findAmbiguousDate("due January 5")).toBe("January 5");
    expect(findAmbiguousDate("due 13/04/2027")).toBe("13/04/2027");
  });
  it("ignores unambiguous dates", () => {
    expect(findAmbiguousDate("due 11/20/2026")).toBeNull();
    expect(findAmbiguousDate("due November 20, 2026")).toBeNull();
    expect(findAmbiguousDate("no date here")).toBeNull();
  });
});

describe("parseAllDates", () => {
  it("lists every distinct date in order", () => {
    expect(parseAllDates("Sent November 2, 2026. Due November 20, 2026. Due November 20, 2026.")).toEqual([
      "2026-11-02",
      "2026-11-20",
    ]);
  });
});
