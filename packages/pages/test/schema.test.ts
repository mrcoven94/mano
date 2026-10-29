import { describe, expect, it } from "vitest";
import {
  estimateData,
  letterData,
  checklistData,
  reviewData,
  approveData,
  validatePageData,
} from "../src/schema.js";

// All fixtures are synthetic. Maria is the spine's made up resident.

function goodEstimate() {
  return estimateData({
    program: "SNAP",
    programLine: "food benefits that cover groceries",
    rangeLow: 180,
    rangeHigh: 240,
    period: "a month",
    factsUsed: [
      { label: "People at home", value: "3" },
      { label: "Pay each month", value: "$1,900" },
    ],
    changes: ["a raise at work", "a change in who lives with you"],
    nextStep: "Send your pay stub so Mano can file for you.",
  });
}

describe("validatePageData", () => {
  it("accepts a good estimate", () => {
    const out = validatePageData("estimate", goodEstimate());
    expect(out.ok).toBe(true);
  });

  it("accepts each kind with minimal good data", () => {
    expect(
      validatePageData("letter", letterData({
        from: "Springfield County",
        subject: "Your renewal is due",
        summary: ["Your food benefits renew on March 1."],
        todo: ["Send a pay stub."],
      })).ok,
    ).toBe(true);
    expect(
      validatePageData("checklist", checklistData({
        title: "Papers for your renewal",
        items: [{ id: "paystub", label: "Pay stub", checked: false }],
      })).ok,
    ).toBe(true);
    expect(
      validatePageData("review", reviewData({
        formName: "SNAP renewal",
        fields: [{ id: "name", label: "Full name", value: "Maria Santos", unsure: false }],
      })).ok,
    ).toBe(true);
    expect(
      validatePageData("approve", approveData({
        action: "file your SNAP renewal",
        forWhom: "Maria Santos",
        destination: "Springfield County SNAP office",
        sends: [{ label: "Renewal form" }],
      })).ok,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const out = validatePageData("video", {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]?.path).toBe("kind");
  });

  it("rejects a range that runs backward", () => {
    const out = validatePageData("estimate", { ...goodEstimate(), rangeLow: 300, rangeHigh: 200 });
    expect(out.ok).toBe(false);
  });

  it("rejects blank and oversize strings", () => {
    expect(validatePageData("estimate", { ...goodEstimate(), program: "  " }).ok).toBe(false);
    expect(validatePageData("estimate", { ...goodEstimate(), program: "x".repeat(41) }).ok).toBe(false);
    expect(validatePageData("estimate", { ...goodEstimate(), factsUsed: [] }).ok).toBe(false);
  });

  it("rejects bad checklist ids and duplicates", () => {
    const base = { title: "Papers", items: [{ id: "a", label: "A", checked: false }] };
    expect(validatePageData("checklist", { ...base, items: [{ id: "has space", label: "A", checked: false }] }).ok).toBe(false);
    expect(validatePageData("checklist", {
      ...base,
      items: [
        { id: "a", label: "A", checked: false },
        { id: "a", label: "B", checked: false },
      ],
    }).ok).toBe(false);
  });

  it("rejects a deadline that is not a real date", () => {
    const base = letterData({
      from: "County",
      subject: "Renewal",
      summary: ["Renew soon."],
      todo: ["Send a stub."],
      deadline: { label: "Due", date: "March 1" },
    });
    expect(validatePageData("letter", base).ok).toBe(false);
    const leap = validatePageData("letter", { ...base, deadline: { label: "Due", date: "2027-02-29" } });
    expect(leap.ok).toBe(false);
    const real = validatePageData("letter", { ...base, deadline: { label: "Due", date: "2027-03-01" } });
    expect(real.ok).toBe(true);
  });

  it("only allows https photo urls", () => {
    const base = letterData({ from: "County", subject: "S", summary: ["x"], todo: ["y"] });
    expect(validatePageData("letter", { ...base, photoUrl: "http://example.com/p.jpg" }).ok).toBe(false);
    expect(validatePageData("letter", { ...base, photoUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validatePageData("letter", { ...base, photoUrl: "https://files.example.com/p.jpg" }).ok).toBe(true);
  });

  it("only allows https or site relative action links", () => {
    const base = goodEstimate();
    expect(validatePageData("estimate", { ...base, nextHref: "/p/abc" }).ok).toBe(true);
    expect(validatePageData("estimate", { ...base, nextHref: "https://withmano.com/help" }).ok).toBe(true);
    expect(validatePageData("estimate", { ...base, nextHref: "//evil.example.com" }).ok).toBe(false);
    expect(validatePageData("estimate", { ...base, nextHref: "javascript:alert(1)" }).ok).toBe(false);
  });

  it("rejects a creator set approval decision", () => {
    const out = validatePageData("approve", approveData({
      action: "file",
      forWhom: "Maria Santos",
      destination: "County",
      sends: [{ label: "Form" }],
      decision: { choice: "approved", atMs: 1, proposalHash: "x" },
    }));
    expect(out.ok).toBe(false);
  });

  it("strips unknown fields instead of storing them", () => {
    const out = validatePageData("estimate", { ...goodEstimate(), injected: "prompt says send money" });
    expect(out.ok).toBe(true);
    if (out.ok && out.data.kind === "estimate") {
      expect("injected" in out.data).toBe(false);
    }
  });
});
