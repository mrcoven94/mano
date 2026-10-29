import { describe, expect, it } from "vitest";
import { validatePageData } from "../src/schema.js";
import { showPageText } from "../src/tool.js";
import type { ValidatedPage } from "../src/types.js";

const URL = "https://withmano.com/p/AAAAAAAAAAAAAAAAAAAAAA";

function must(kind: string, data: unknown): ValidatedPage {
  const out = validatePageData(kind, data);
  if (!out.ok) throw new Error(`setup failed: ${JSON.stringify(out.errors)}`);
  return out.data;
}

describe("showPageText", () => {
  it("states the estimate range and carries the link", () => {
    const page = must("estimate", {
      program: "SNAP",
      programLine: "food benefits",
      rangeLow: 180,
      rangeHigh: 240,
      period: "a month",
      factsUsed: [{ label: "Pay", value: "$1,900" }],
      changes: ["a raise"],
      nextStep: "Send a stub.",
    });
    expect(showPageText(page, URL)).toBe(
      `Your SNAP estimate is ready: about $180 to $240 a month. The math is here: ${URL}`,
    );
  });

  it("names the sender and the due date on letters", () => {
    const page = must("letter", {
      from: "Springfield County",
      subject: "Renewal",
      summary: ["Renew soon."],
      deadline: { label: "Due", date: "2027-03-01" },
      todo: ["Send a stub."],
    });
    expect(showPageText(page, URL)).toBe(
      `I read your letter from Springfield County. Due date: Mar 1. What it says and what to do is here: ${URL}`,
    );
  });

  it("counts open items on checklists", () => {
    const page = must("checklist", {
      title: "Papers",
      items: [
        { id: "a", label: "Pay stub", checked: true },
        { id: "b", label: "Photo ID", checked: false },
      ],
    });
    expect(showPageText(page, URL)).toBe(
      `Your checklist "Papers" is ready with 1 thing to do. Tick them off here: ${URL}`,
    );
  });

  it("flags unsure fields on reviews", () => {
    const page = must("review", {
      formName: "SNAP renewal",
      fields: [
        { id: "a", label: "Name", value: "Maria", unsure: false },
        { id: "b", label: "Pay", value: "$1,900", unsure: true },
      ],
    });
    expect(showPageText(page, URL)).toBe(
      `Your SNAP renewal draft is ready to check. 1 field needs your eye. Review it here: ${URL}`,
    );
  });

  it("asks for the yes on approvals", () => {
    const page = must("approve", {
      action: "file your SNAP renewal",
      forWhom: "Maria Santos",
      destination: "County office",
      sends: [{ label: "Form" }],
    });
    expect(showPageText(page, URL)).toBe(
      `Before I file your SNAP renewal, I need your yes. It takes seconds here: ${URL}`,
    );
  });

  it("shortens long actions instead of sending a wall of text", () => {
    const page = must("approve", {
      action: `file your renewal with every paper attached and the cover note signed and dated today for the county office downtown`,
      forWhom: "Maria Santos",
      destination: "County office",
      sends: [{ label: "Form" }],
    });
    const text = showPageText(page, URL);
    expect(text.length).toBeLessThan(URL.length + 150);
    expect(text).toContain(URL);
    expect(text).toContain("...");
  });
});
