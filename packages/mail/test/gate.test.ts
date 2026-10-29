import { describe, expect, it } from "vitest";
import { chronologyOf, gateSentence, isDeadlineLike, obligationOf } from "../src/gate.js";

const NOTICE = "2026-11-02";

describe("gateSentence publishes only the closed forms", () => {
  it.each([
    ["by", "Return your signed recertification form and the proofs listed below by December 5, 2026.", "2026-12-05"],
    ["by", "You must respond by December 12, 2026.", "2026-12-12"],
    ["by", "Your paperwork must arrive by December 12, 2026.", "2026-12-12"],
    ["by", "Please send them so they arrive by November 15, 2026.", "2026-11-15"],
    ["by", "Your renewal is due by December 14, 2026.", "2026-12-14"],
    ["by", "Return the form by 11/20/2026.", "2026-11-20"],
    ["by", "Pay $50.00 by December 1, 2026.", "2026-12-01"],
    ["by", "Your hearing request must arrive by November 30, 2026.", "2026-11-30"],
    ["by", "Send it so it arrives by November 22, 2026.", "2026-11-22"],
    ["on-or-before", "You must respond on or before December 12, 2026.", "2026-12-12"],
    ["no-later-than", "You must renew your case no later than December 15, 2026.", "2026-12-15"],
    ["due", "Your renewal is due November 20, 2026.", "2026-11-20"],
    ["due", "Your premium is due on December 1, 2026.", "2026-12-01"],
  ])("%s: %s", (form, sentence, iso) => {
    expect(gateSentence(sentence, NOTICE)).toMatchObject({ kind: "deadline", form, iso });
  });

  it("never publishes a counted deadline; it asks with the count", () => {
    expect(gateSentence("You must respond within 10 days of November 25, 2026.", NOTICE)).toEqual({
      kind: "ask",
      reason: "counted",
      count: { days: 10, fromIso: "2026-11-25", resultIso: "2026-12-05" },
    });
    expect(gateSentence("Send the form within 10 calendar days after November 25, 2026.", NOTICE)).toMatchObject({
      kind: "ask",
      count: { resultIso: "2026-12-05" },
    });
    expect(gateSentence("Request a hearing within 30 days of the date of this notice.", NOTICE)).toEqual({
      kind: "ask",
      reason: "counted",
      count: { days: 30, fromIso: NOTICE, resultIso: "2026-12-02" },
    });
  });
});

describe("gateSentence asks on everything else", () => {
  it.each([
    "You must not respond before November 20, 2026.",
    "You must respond within 10 days after November 25, 2026 or within 20 days after that date.",
    "You may respond after November 20, 2026.",
    "Respond by November 20 or December 1, 2026.",
    "Do not pay before November 20, 2026.",
    "You do not need to respond by November 20, 2026.",
    "Send the form or call our office by November 20, 2026.",
    "If you moved, send proof of address by November 20, 2026.",
    "Return the form by November 20, 2026 if you want to keep your benefits.",
    "Your benefits will end on December 31, 2026 unless you renew by December 15, 2026.",
    "You must respond by December 12, 2026 or within 10 days of receipt.",
    "If you disagree, you have 60 days from the date of this notice to file an appeal.",
    "We must receive your packet by November 20, 2026.",
    "Respond by November 20, 2026 to keep your benefits.",
    "You must respond before December 12, 2026.",
    "Submit the form within 10 business days after November 25, 2026.",
    "You can send the form by November 20, 2026.",
    "Your payment was due November 15, 2026.",
    "Nothing is due November 20, 2026.",
    "Send pay stubs for the last 30 days by November 20, 2026.",
    "Respond by 03/04/2027.",
    "Submit the form by 11/15/26; we finish processing by November 20, 2026.",
    "Submit the form by tomorrow; we finish processing by November 20, 2026.",
    "Return the form at your discretion by November 20, 2026.",
    "Neither payment is due November 20, 2026.",
    "Your refund is due on November 20, 2026.",
    "Your refund must be paid by November 20, 2026.",
    "Renewal due November 20, 2026.",
    "It must arrive by November 25, 2026.",
    "Dear Maria Santos, Return the form by November 20, 2026.",
    "Your renewal is due tomorrow.",
    "Your renewal is due 11/15/26.",
    "Respond within ten days of receipt.",
    "Your payment of $45.00 for November 2026 was due on November 15, 2026.",
  ])("%s", (sentence) => {
    expect(gateSentence(sentence, NOTICE)).toMatchObject({ kind: "ask" });
  });

  it("asks when a counted deadline has no notice date to count from", () => {
    expect(gateSentence("Appeal within 30 days of the date of this notice.", null)).toEqual({
      kind: "ask",
      reason: "no-notice-date",
    });
  });

  it("asks when the date is the notice date or out of range", () => {
    expect(gateSentence("Respond by November 2, 2026.", NOTICE)).toEqual({ kind: "ask", reason: "notice-date" });
    expect(gateSentence("Respond by October 24, 2026.", NOTICE)).toEqual({ kind: "ask", reason: "before-notice" });
    expect(gateSentence("Respond by December 1, 2027.", NOTICE)).toEqual({ kind: "ask", reason: "too-far" });
  });
});

describe("gateSentence dates to know", () => {
  it.each([
    ["Your interview is on December 1, 2026.", "2026-12-01"],
    ["You will receive your new card on November 20, 2026.", "2026-11-20"],
    ["Coverage ends December 20, 2026.", "2026-12-20"],
  ])("%s", (sentence, iso) => {
    expect(gateSentence(sentence, NOTICE)).toEqual({ kind: "date-to-know", iso });
  });

  it("never files a negated, conditional or two-date sentence as a date to know", () => {
    expect(gateSentence("Your benefits will not end on December 31, 2026.", NOTICE).kind).toBe("ask");
    expect(gateSentence("If we do not hear from you, your aid ends on December 31, 2026.", NOTICE).kind).toBe("ask");
    expect(gateSentence("Your aid ends on December 31, 2026 or January 31, 2027.", NOTICE).kind).toBe("ask");
    expect(gateSentence("Without proof of address, your case may close on November 30, 2026.", NOTICE).kind).toBe("ask");
  });

  it("skips sentences with no date or count", () => {
    expect(gateSentence("Send the signed renewal form.", NOTICE)).toEqual({ kind: "no-date" });
  });
});

describe("obligationOf", () => {
  it("reads the duty from the sentence words", () => {
    expect(obligationOf("Respond by November 20, 2026")).toBe("respond");
    expect(obligationOf("Appeal by December 1, 2026")).toBe("appeal");
    expect(obligationOf("Renewal due November 20, 2026")).toBe("renew");
    expect(obligationOf("Send your premium payment by December 5, 2026")).toBe("pay");
    expect(obligationOf("Send pay stubs for the last 30 days")).toBe("respond");
    expect(obligationOf("November 20, 2026")).toBe("other");
  });
});

describe("chronologyOf", () => {
  it("accepts sane deadlines and flags the rest", () => {
    expect(chronologyOf("2026-11-20", NOTICE)).toBe("ok");
    expect(chronologyOf("2026-10-24", NOTICE)).toBe("before-notice");
    expect(chronologyOf("2027-11-03", NOTICE)).toBe("too-far");
    expect(chronologyOf("2027-11-02", NOTICE)).toBe("ok");
    expect(chronologyOf("2026-10-24", null)).toBe("ok");
  });
});

describe("isDeadlineLike", () => {
  it.each([
    "Your renewal is due tomorrow",
    "Respond within ten days of receipt",
    "You have 60 days from the date of this notice to appeal",
    "Send it by next week",
    "Reply by 11/15/26",
    "Reply by 11/15",
    "Call us immediately",
    "Return it by December 5",
  ])("flags %s", (sentence) => {
    expect(isDeadlineLike(sentence)).toBe(true);
  });

  it.each([
    "Notice Date: November 2, 2026",
    "Coverage ends December 20, 2026",
    "Pay stubs for the last 30 days for every working household member",
    "Call (555) 214-8800, Monday through Friday, 8:00 AM to 5:00 PM",
    "Send it by mail",
  ])("leaves %s alone", (sentence) => {
    expect(isDeadlineLike(sentence)).toBe(false);
  });
});
