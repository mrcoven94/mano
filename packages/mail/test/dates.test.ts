import { describe, expect, it } from "vitest";
import { findAmbiguousDate, parseAllDates, parseWrittenDate, sentenceContaining } from "../src/dates.js";

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

describe("sentenceContaining", () => {
  it("finds the sentence stating the text", () => {
    expect(sentenceContaining("November 20, 2026", "Hello. Respond by November 20, 2026. Bye.")).toBe(
      "Respond by November 20, 2026.",
    );
    expect(sentenceContaining("November 20, 2026", "Nothing here.")).toBeNull();
  });
  it("keeps the letterhead out of the first body sentence", () => {
    const text = "Notice Date: November 2, 2026\n\nDear Maria,\n\nReturn the form by November 20, 2026.";
    expect(sentenceContaining("November 20, 2026", text)).toBe("Return the form by November 20, 2026.");
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
