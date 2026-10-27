import { describe, expect, it } from "vitest";
import {
  extraLetterExtraction,
  groupDeterministic,
  parsePageExtraction,
  type GroupablePage,
  type PageExtraction,
} from "../src/read.js";

function extraction(over: Partial<PageExtraction>): PageExtraction {
  const nil = { text: null as string | null, box: null };
  return {
    readable: true,
    readabilityNote: null,
    fullText: "",
    sender: nil,
    program: nil,
    subject: nil,
    asked: [],
    deadlineText: nil,
    consequence: nil,
    referenceNo: nil,
    noticeDate: nil,
    phones: [],
    links: [],
    addresses: [],
    pageMarker: nil,
    extraLetter: null,
    usage: null,
    elapsedMs: 0,
    ...over,
  };
}

const field = (text: string | null) => ({ text, box: null });

describe("parsePageExtraction", () => {
  it("parses fields with boxes", () => {
    const ex = parsePageExtraction(
      JSON.stringify({
        readable: true,
        readability_note: null,
        full_text: "Dear Maria,",
        sender: { text: "County Office", box_2d: [1, 2, 3, 4] },
        program: { text: null, box_2d: null },
        subject: { text: null, box_2d: null },
        asked: [{ text: "Send pay stubs", box_2d: [10, 10, 20, 200] }],
        deadline_text: { text: "November 20, 2026", box_2d: null },
        consequence: { text: null, box_2d: null },
        reference_no: { text: "CA-1", box_2d: null },
        notice_date: { text: null, box_2d: null },
        phones: [],
        links: [],
        addresses: [],
        page_marker: { text: null, box_2d: null },
      }),
    );
    expect(ex.readable).toBe(true);
    expect(ex.sender).toEqual({ text: "County Office", box: { ymin: 1, xmin: 2, ymax: 3, xmax: 4 } });
    expect(ex.asked).toHaveLength(1);
    expect(ex.deadlineText.text).toBe("November 20, 2026");
  });
  it("fails closed to unreadable on garbage", () => {
    const ex = parsePageExtraction("%%%");
    expect(ex.readable).toBe(false);
    expect(ex.sender.text).toBeNull();
  });
  it("parses a second letter on a shared crop", () => {
    const ex = parsePageExtraction(
      JSON.stringify({
        readable: true,
        readability_note: null,
        full_text: "two letters",
        sender: { text: "Office A", box_2d: null },
        program: { text: null, box_2d: null },
        subject: { text: null, box_2d: null },
        asked: [],
        deadline_text: { text: null, box_2d: null },
        consequence: { text: null, box_2d: null },
        reference_no: { text: null, box_2d: null },
        notice_date: { text: null, box_2d: null },
        phones: [],
        links: [],
        addresses: [],
        page_marker: { text: null, box_2d: null },
        extra_letter: {
          sender: { text: "Office B", box_2d: [10, 500, 40, 900] },
          program: { text: null, box_2d: null },
          subject: { text: null, box_2d: null },
          asked: [],
          deadline_text: { text: "December 1, 2026", box_2d: null },
          reference_no: { text: "B-2", box_2d: null },
          notice_date: { text: null, box_2d: null },
          phones: [],
          links: [],
        },
      }),
    );
    expect(ex.extraLetter?.sender.text).toBe("Office B");
    const pseudo = extraLetterExtraction(ex)!;
    expect(pseudo.readable).toBe(true);
    expect(pseudo.sender.text).toBe("Office B");
    expect(pseudo.referenceNo.text).toBe("B-2");
    expect(pseudo.extraLetter).toBeNull();
  });
  it("ignores extra letters without a sender", () => {
    const ex = parsePageExtraction(
      JSON.stringify({
        readable: true,
        readability_note: null,
        full_text: "one letter",
        sender: { text: "Office A", box_2d: null },
        program: { text: null, box_2d: null },
        subject: { text: null, box_2d: null },
        asked: [],
        deadline_text: { text: null, box_2d: null },
        consequence: { text: null, box_2d: null },
        reference_no: { text: null, box_2d: null },
        notice_date: { text: null, box_2d: null },
        phones: [],
        links: [],
        addresses: [],
        page_marker: { text: null, box_2d: null },
        extra_letter: null,
      }),
    );
    expect(extraLetterExtraction(ex)).toBeNull();
  });
});

describe("groupDeterministic", () => {
  const page = (index: number, sender: string | null, ref: string | null, marker: string | null = null): GroupablePage => ({
    index,
    extraction: extraction({ sender: field(sender), referenceNo: field(ref), pageMarker: field(marker) }),
  });
  it("groups pages sharing sender and reference", () => {
    const { groups, ambiguous } = groupDeterministic([
      page(0, "County Office", "CA-1", "page 1 of 2"),
      page(1, "County Office", "CA-1", "page 2 of 2"),
      page(2, "Energy Co", "U-9"),
    ]);
    expect(ambiguous).toEqual([]);
    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });
  it("marks continued pages without keys as ambiguous", () => {
    const { groups, ambiguous } = groupDeterministic([page(0, null, null, "page 1 of 2"), page(1, null, null, "page 2 of 2")]);
    expect(groups).toEqual([]);
    expect(ambiguous).toEqual([0, 1]);
  });
  it("keeps different letters apart", () => {
    const { groups, ambiguous } = groupDeterministic([page(0, "Office A", "A-1"), page(1, "Office B", "B-2")]);
    expect(groups).toEqual([[0], [1]]);
    expect(ambiguous).toEqual([]);
  });
});
