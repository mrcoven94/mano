import { describe, expect, it } from "vitest";
import { pagePreview } from "../src/preview.js";
import { validatePageData } from "../src/schema.js";
import type { ValidatedPage } from "../src/types.js";

const SENTINELS = ["ZXQ SENTINEL ALPHA", "ZXQ SENTINEL BETA", "ZXQ 555 0199", "ZXQ $9,876"];

function must(kind: string, data: unknown): ValidatedPage {
  const out = validatePageData(kind, data);
  if (!out.ok) throw new Error(`setup failed: ${JSON.stringify(out.errors)}`);
  return out.data;
}

const PAGES: ValidatedPage[] = [
  must("estimate", {
    program: "SNAP",
    programLine: SENTINELS[0],
    rangeLow: 9876,
    rangeHigh: 9876,
    period: "a month",
    factsUsed: [{ label: SENTINELS[1], value: SENTINELS[2] ?? "" }],
    changes: [SENTINELS[3] ?? ""],
    nextStep: SENTINELS[0],
  }),
  must("letter", {
    from: SENTINELS[0],
    subject: SENTINELS[1],
    summary: [SENTINELS[2] ?? ""],
    deadline: { label: SENTINELS[3] ?? "", date: "2027-03-01" },
    todo: [SENTINELS[0]],
    photoUrl: "https://files.example.com/p.jpg",
  }),
  must("checklist", {
    title: SENTINELS[0],
    intro: SENTINELS[1],
    items: [{ id: "a", label: SENTINELS[2] ?? "", detail: SENTINELS[3], checked: false }],
  }),
  must("review", {
    formName: SENTINELS[0],
    fields: [{ id: "a", label: SENTINELS[1], value: SENTINELS[2] ?? "", unsure: true, note: SENTINELS[3] }],
  }),
  must("approve", {
    action: SENTINELS[0],
    forWhom: SENTINELS[1] ?? "",
    destination: SENTINELS[2] ?? "",
    sends: [{ label: SENTINELS[3], detail: SENTINELS[0] }],
    note: SENTINELS[1],
  }),
];

describe("pagePreview", () => {
  it("never leaks page data into the title or description", () => {
    for (const page of PAGES) {
      const preview = pagePreview(page);
      const joined = `${preview.title}\n${preview.description}`;
      for (const sentinel of SENTINELS) {
        expect(joined).not.toContain(sentinel);
      }
      expect(joined).not.toContain("9,876");
      expect(joined).not.toContain("9876");
    }
  });

  it("names the program on estimates, per the brief example", () => {
    const preview = pagePreview(PAGES[0] as ValidatedPage);
    expect(preview.title).toBe("Your SNAP estimate");
  });

  it("keeps titles short enough to unfurl", () => {
    for (const page of PAGES) {
      const preview = pagePreview(page);
      expect(preview.title.length).toBeLessThanOrEqual(60);
      expect(preview.description.length).toBeLessThanOrEqual(160);
    }
  });
});
