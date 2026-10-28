import { describe, expect, it } from "vitest";
import {
  chronologyOf,
  countDeadlineExpressions,
  findAmbiguousDate,
  findHedge,
  hasObligationPhrase,
  isRelativeExpression,
  obligationOf,
  parseAllDates,
  parseWrittenDate,
  resolveDeadline,
  sentenceContaining,
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
  it("withholds relative wording it cannot count instead of promoting a date", () => {
    expect(resolveDeadline("10 days before November 25, 2026", null)).toEqual({
      kind: "unsupported",
      expression: "10 days before November 25, 2026",
    });
    expect(resolveDeadline("within 2 weeks of November 25, 2026", null).kind).toBe("unsupported");
    expect(resolveDeadline("respond 3 days prior to November 25, 2026", null).kind).toBe("unsupported");
  });
  it("withholds a mixed expression when any date in it is ambiguous", () => {
    const r = resolveDeadline("due 03/04/2027, see the November 5, 2026 notice", null);
    expect(r).toEqual({ kind: "ambiguous", expression: "03/04/2027" });
  });
  it("still reads a bare before-date as the deadline itself", () => {
    expect(resolveDeadline("before December 12, 2026", null)).toEqual({ kind: "absolute", iso: "2026-12-12" });
  });
  it("asks on caps and before-wording after a count instead of resolving", () => {
    expect(resolveDeadline("within 10 days after November 25, 2026, but no later than November 30, 2026", null)).toEqual(
      {
        kind: "unsupported",
        expression: "within 10 days after November 25, 2026, but no later than November 30, 2026",
      },
    );
    expect(resolveDeadline("within 10 days before November 25, 2026", null)).toEqual({
      kind: "unsupported",
      expression: "within 10 days before November 25, 2026",
    });
  });
  it("asks when one expression holds two dates", () => {
    expect(resolveDeadline("due November 20, 2026, see November 2, 2026", null)).toEqual({
      kind: "ambiguous",
      expression: "due November 20, 2026, see November 2, 2026",
    });
    expect(resolveDeadline("within 10 days of November 25, 2026 or November 26, 2026", null).kind).toBe("ambiguous");
  });
  it("checks every numeric date, not just the first", () => {
    expect(findAmbiguousDate("Respond by 11/20/2026 or 03/04/2027")).toBe("03/04/2027");
    expect(findAmbiguousDate("due 11/20/2026 then 13/04/2027")).toBe("13/04/2027");
    expect(findAmbiguousDate("due 11/20/2026 or 11/21/2026")).toBeNull();
    expect(resolveDeadline("Respond by 11/20/2026 or 03/04/2027", null)).toEqual({
      kind: "ambiguous",
      expression: "03/04/2027",
    });
  });
  it("asks on ambiguity ahead of the count and on second dates", () => {
    expect(resolveDeadline("Respond by 03/04/2027 or within 10 days after November 25, 2026", null)).toEqual({
      kind: "ambiguous",
      expression: "03/04/2027",
    });
    expect(resolveDeadline("Respond by November 20, 2026 or within 10 days after November 25, 2026", null)).toEqual({
      kind: "ambiguous",
      expression: "Respond by November 20, 2026 or within 10 days after November 25, 2026",
    });
  });
  it("asks on ambiguity anywhere, even past a notice anchor", () => {
    expect(resolveDeadline("60 days from the November 5 notice", "November 2, 2026")).toEqual({
      kind: "ambiguous",
      expression: "November 5",
    });
  });
});

describe("obligationOf", () => {
  it("reads the duty from the sentence verbs", () => {
    expect(obligationOf("Respond by November 20, 2026")).toBe("respond");
    expect(obligationOf("we must receive your packet by November 20, 2026")).toBe("respond");
    expect(obligationOf("Appeal by December 1, 2026")).toBe("appeal");
    expect(obligationOf("Ask in writing within 14 days of the decision notice")).toBe("appeal");
    expect(obligationOf("within 14 days of the decision notice")).toBe("appeal");
    expect(obligationOf("Renewal due November 20, 2026")).toBe("renew");
    expect(obligationOf("Send your premium payment by December 5, 2026")).toBe("pay");
    expect(obligationOf("November 20, 2026")).toBe("other");
  });
  it("does not mistake pay stubs for a payment", () => {
    expect(obligationOf("Send pay stubs for the last 30 days")).toBe("respond");
  });
});

describe("hasObligationPhrase", () => {
  it("matches duty language putting a date on the resident", () => {
    expect(hasObligationPhrase("we must receive your packet by November 20, 2026")).toBe(true);
    expect(hasObligationPhrase("Renewal due November 20, 2026")).toBe(true);
    expect(hasObligationPhrase("Respond by November 20, 2026")).toBe(true);
    expect(hasObligationPhrase("Send it so it arrives by November 18, 2026")).toBe(true);
    expect(hasObligationPhrase("Return the form by December 5, 2026")).toBe(true);
    expect(hasObligationPhrase("Appeal by December 1, 2026")).toBe(true);
    expect(hasObligationPhrase("Pay in full by November 24, 2026")).toBe(true);
    expect(hasObligationPhrase("Renew by November 20, 2026")).toBe(true);
    expect(hasObligationPhrase("arrive no later than November 30, 2026")).toBe(true);
  });
  it("rejects causal due, pay stubs, and informational verbs", () => {
    expect(hasObligationPhrase("delayed due to a backlog")).toBe(false);
    expect(hasObligationPhrase("Send your pay stubs by November 20, 2026")).toBe(true);
    expect(hasObligationPhrase("Mail your pay stubs by Friday")).toBe(false);
    expect(hasObligationPhrase("your renewal may be denied and your coverage may end on December 20, 2026")).toBe(false);
    expect(hasObligationPhrase("Your first payment of $967.00 will arrive on December 1, 2026")).toBe(false);
    expect(hasObligationPhrase("November 20, 2026")).toBe(false);
  });
});

describe("findHedge", () => {
  it("finds uncertainty words", () => {
    expect(findHedge("your renewal may be denied")).toBe("may");
    expect(findHedge("you might have more time")).toBe("might");
    expect(findHedge("it could arrive late")).toBe("could");
    expect(findHedge("payment will arrive on December 1, 2026")).toBe("will arrive");
    expect(findHedge("if you disagree, appeal")).toBe("if");
  });
  it("ignores the month May and allows if for relatives", () => {
    expect(findHedge("due May 5, 2027")).toBeNull();
    expect(findHedge("Respond by November 20, 2026")).toBeNull();
    expect(findHedge("if you disagree, you have 60 days", { allowIf: true })).toBeNull();
  });
});

describe("isRelativeExpression", () => {
  it("matches counting constructions", () => {
    expect(isRelativeExpression("within 10 days of November 25, 2026")).toBe(true);
    expect(isRelativeExpression("60 days from the date of this notice")).toBe(true);
    expect(isRelativeExpression("Respond by November 20, 2026")).toBe(false);
  });
});

describe("countDeadlineExpressions", () => {
  it("counts relative constructions plus outside absolute dates", () => {
    expect(countDeadlineExpressions("Respond by November 20, 2026.")).toBe(1);
    expect(countDeadlineExpressions("within 10 days after November 25, 2026")).toBe(1);
    expect(countDeadlineExpressions("Respond by November 20, 2026 or within 10 days of receipt.")).toBe(2);
    expect(countDeadlineExpressions("November 20, 2026 or December 1, 2026")).toBe(2);
    expect(countDeadlineExpressions("no dates here")).toBe(0);
  });
});

describe("sentenceContaining", () => {
  it("finds the sentence stating the text", () => {
    expect(sentenceContaining("November 20, 2026", "Hello. Respond by November 20, 2026. Bye.")).toBe(
      "Respond by November 20, 2026.",
    );
    expect(sentenceContaining("November 20, 2026", "Nothing here.")).toBeNull();
  });
});

describe("chronologyOf", () => {
  it("accepts sane deadlines and flags the rest", () => {
    expect(chronologyOf("2026-11-20", "2026-11-02")).toBe("ok");
    expect(chronologyOf("2026-10-24", "2026-11-02")).toBe("before-notice");
    expect(chronologyOf("2027-11-03", "2026-11-02")).toBe("too-far");
    expect(chronologyOf("2027-11-02", "2026-11-02")).toBe("ok");
    expect(chronologyOf("2026-10-24", null)).toBe("ok");
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
