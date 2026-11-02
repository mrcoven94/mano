import { describe, expect, it } from "vitest";
import {
  dateOccurrences,
  findAmbiguousDate,
  headerDates,
  parseAllDates,
  parseWrittenDate,
  recoverSentence,
  splitSentences,
} from "../src/dates.js";

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

describe("splitSentences", () => {
  it("removes only a salutation line and keeps the letterhead out of the body", () => {
    const text = "Notice Date: November 2, 2026\n\nDear Maria Santos,\nReturn the form by November 20, 2026. Thank you.";
    expect(splitSentences(text)).toEqual(["Notice Date: November 2, 2026", "Return the form by November 20, 2026", "Thank you"]);
  });
  it("never lets a salutation swallow a condition", () => {
    expect(splitSentences("Dear Maria\nIf you moved, submit proof by November 20, 2026.")).toEqual([
      "If you moved, submit proof by November 20, 2026",
    ]);
    expect(splitSentences("Dear Maria, if you moved, submit proof by November 20, 2026.")).toEqual([
      "Dear Maria, if you moved, submit proof by November 20, 2026",
    ]);
  });
});

describe("recoverSentence", () => {
  const text = "Hello. Do not submit proof by November 20, 2026. Respond by December 1, 2026.";
  it("returns the one sentence that contains the text", () => {
    expect(recoverSentence("submit proof by November 20, 2026", text)).toBe("Do not submit proof by November 20, 2026");
    expect(recoverSentence("December 1, 2026.", text)).toBe("Respond by December 1, 2026");
  });
  it("returns null when the text is not verbatim or sits in more than one sentence", () => {
    expect(recoverSentence("Submit proof by November 20 2026", text)).toBeNull();
    expect(recoverSentence("2026", text)).toBeNull();
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

describe("headerDates", () => {
  it("finds a notice date alone on a header line, label allowed", () => {
    expect(headerDates("County Office\nNotice Date: November 2, 2026\n\nDear Maria,\nReturn it by December 5, 2026.")).toEqual([
      "2026-11-02",
    ]);
  });
  it("ignores dates inside a sentence or below the salutation", () => {
    expect(headerDates("County Office. Notice date November 2, 2026.")).toEqual([]);
    expect(headerDates("County Office\nDear Maria,\nNovember 2, 2026")).toEqual([]);
  });
});

describe("dateOccurrences", () => {
  it("reads abbreviated months and keeps every occurrence", () => {
    expect(dateOccurrences("Before 15 Nov. 2026. By Nov. 20, 2026. By November 20, 2026.")).toEqual([
      "2026-11-15",
      "2026-11-20",
      "2026-11-20",
    ]);
  });
  it("keeps an abbreviated date inside one sentence", () => {
    expect(splitSentences("Submit proof before 15 Nov. 2026. Submit proof by November 20, 2026.")).toEqual([
      "Submit proof before 15 Nov 2026",
      "Submit proof by November 20, 2026",
    ]);
  });
});
