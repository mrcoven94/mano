import { describe, expect, it } from "vitest";
import {
  extraLetterExtraction,
  groupDeterministic,
  groupWithModel,
  parsePageExtraction,
  readPage,
  type GroupablePage,
  type PageExtraction,
} from "../src/read.js";
import { RecordedModelClient, recordedText, type ModelInputItem } from "../src/model.js";

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
    deadlines: [],
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
        deadlines: [{ text: "November 20, 2026", box_2d: null }],
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
    expect(ex.deadlines[0]!.text).toBe("November 20, 2026");
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
        deadlines: [],
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
          deadlines: [{ text: "December 1, 2026", box_2d: null }],
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
        deadlines: [],
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
  const page = (
    index: number,
    sender: string | null,
    ref: string | null,
    marker: string | null = null,
    notice: string | null = null,
    subject: string | null = null,
  ): GroupablePage => ({
    index,
    extraction: extraction({
      sender: field(sender),
      referenceNo: field(ref),
      pageMarker: field(marker),
      noticeDate: field(notice),
      subject: field(subject),
    }),
  });
  it("merges pages whose markers chain", () => {
    const { groups, ambiguous } = groupDeterministic([
      page(0, "County Office", "CA-1", "page 1 of 2"),
      page(1, "County Office", "CA-1", "page 2 of 2"),
      page(2, "Energy Co", "U-9"),
    ]);
    expect(ambiguous).toEqual([]);
    expect(groups).toContainEqual([0, 1]);
    expect(groups).toContainEqual([2]);
  });
  it("merges same key with same notice date and subject", () => {
    const { groups, ambiguous } = groupDeterministic([
      page(0, "County Office", "CA-1", null, "November 2, 2026", "Renewal"),
      page(1, "County Office", "CA-1", null, "November 2, 2026", "Renewal"),
    ]);
    expect(ambiguous).toEqual([]);
    expect(groups).toEqual([[0, 1]]);
  });
  it("keeps same-case notices apart without continuation evidence", () => {
    // A renewal and a document request from the same office on the same
    // case are two letters, not one.
    const { groups, ambiguous } = groupDeterministic([
      page(0, "County Office", "CA-1", null, "November 2, 2026", "Renewal"),
      page(1, "County Office", "CA-1", null, "November 7, 2026", "Documents Needed"),
    ]);
    expect(ambiguous).toEqual([]);
    expect(groups).toEqual([[0], [1]]);
  });
  it("keeps same key apart when notice and subject are missing", () => {
    const { groups, ambiguous } = groupDeterministic([
      page(0, "County Office", "CA-1"),
      page(1, "County Office", "CA-1"),
    ]);
    expect(ambiguous).toEqual([]);
    expect(groups).toEqual([[0], [1]]);
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

describe("groupWithModel", () => {
  const gpage = (index: number, notice: string | null, subject: string | null, sender = "Secret Office"): GroupablePage => ({
    index,
    extraction: extraction({
      sender: field(sender),
      referenceNo: field("CA-1"),
      noticeDate: field(notice),
      subject: field(subject),
      pageMarker: field("continued"),
    }),
  });
  const clientFor = (groups: number[][]): RecordedModelClient =>
    new RecordedModelClient([{ match: () => true, result: recordedText(JSON.stringify({ groups })) }]);

  it("keeps instructions and letter content in separate messages", async () => {
    const model = clientFor([[0]]);
    await groupWithModel([gpage(0, "November 2, 2026", "Renewal")], model, { synthetic: true });
    const input = model.calls[0]!.input as ModelInputItem[];
    expect(Array.isArray(input)).toBe(true);
    expect(input.map((m) => m.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(input[0])).not.toContain("Secret Office");
    expect(JSON.stringify(input[1])).toContain("Secret Office");
  });

  it("rejects merges across notice dates or subjects", async () => {
    const model = clientFor([[0, 1]]);
    const { groups } = await groupWithModel(
      [gpage(0, "November 2, 2026", "Renewal"), gpage(1, "November 7, 2026", "Documents Needed")],
      model,
      { synthetic: true },
    );
    expect(groups).toEqual([[0], [1]]);
  });

  it("accepts merges with matching notice date and subject", async () => {
    const model = clientFor([[0, 1]]);
    const { groups } = await groupWithModel(
      [gpage(0, "November 2, 2026", "Renewal"), gpage(1, "November 2, 2026", "Renewal")],
      model,
      { synthetic: true },
    );
    expect(groups).toEqual([[0, 1]]);
  });
});

describe("readPage", () => {
  it("sums usage across retry attempts", async () => {
    const valid = JSON.stringify({
      readable: true,
      readability_note: null,
      full_text: "hi",
      sender: { text: null, box_2d: null },
      program: { text: null, box_2d: null },
      subject: { text: null, box_2d: null },
      asked: [],
      deadlines: [],
      consequence: { text: null, box_2d: null },
      reference_no: { text: null, box_2d: null },
      notice_date: { text: null, box_2d: null },
      phones: [],
      links: [],
      addresses: [],
      page_marker: { text: null, box_2d: null },
      extra_letter: null,
    });
    const model = new RecordedModelClient([
      { match: () => true, consume: true, result: { text: "", usage: { inputTokens: 1, outputTokens: 2 }, raw: {} } },
      { match: () => true, consume: true, result: { text: valid, usage: { inputTokens: 10, outputTokens: 20 }, raw: {} } },
    ]);
    const ex = await readPage(Buffer.from([1, 2, 3]), model, { synthetic: true });
    expect(ex.readable).toBe(true);
    expect(ex.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });
});
