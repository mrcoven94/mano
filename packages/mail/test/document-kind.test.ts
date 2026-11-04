import { describe, expect, it } from "vitest";

import { answerReading, documentsRead, readMail } from "../src/index.js";
import { REPLY_LANGUAGES } from "../src/words.js";
import { strictSchemaErrors } from "../src/model.js";
import { parsePageExtraction, PAGE_SCHEMA } from "../src/read.js";
import { NIL, RENEWAL_PAGE, letterPhoto, pageJson, recordedReader } from "./letter-fixture.js";

const read = async (page: string) =>
  readMail([{ bytes: new Uint8Array(await letterPhoto()), mimeType: "image/jpeg", name: "photo-1" }], { personId: "p1", synthetic: true, model: recordedReader([page]) });

const STUB = pageJson({
  document_kind: "pay_stub",
  full_text: "Sample Works LLC\nNet pay $850.00",
  sender: { text: "Sample Works LLC", box_2d: [40, 60, 70, 400] },
  program: NIL,
  subject: NIL,
  asked: [],
  deadlines: [],
  consequence: NIL,
  reference_no: NIL,
  notice_date: NIL,
  phones: [],
});

describe("what the same read says a document is", () => {
  it("asks for the kind in the page's own strict schema, so no second call is needed", () => {
    expect(strictSchemaErrors(PAGE_SCHEMA)).toEqual([]);
    expect((PAGE_SCHEMA.required as string[])).toContain("document_kind");
  });

  it("keeps only a kind on Mano's list", () => {
    expect(parsePageExtraction(pageJson({ document_kind: "pay_stub" })).documentKind).toBe("pay_stub");
    expect(parsePageExtraction(pageJson({ document_kind: "qualifies_for_benefits" })).documentKind).toBe("unknown");
    expect(parsePageExtraction(RENEWAL_PAGE).documentKind).toBeUndefined();
  });

  it("puts the kind on the letter and leaves every field's box in place", async () => {
    const reading = await read(STUB);
    expect(reading.stats.modelCalls.filter((c) => c.purpose === "read")).toHaveLength(1);
    const letter = reading.letters[0]!;
    expect(letter.documentKind).toBe("pay_stub");
    expect(letter.fields.sender?.citation.box).toEqual({ ymin: 40, xmin: 60, ymax: 70, xmax: 400 });
  });

  it("a bill's due date is a duty: it reads as a letter, and the date is not lost", async () => {
    const bill = pageJson({
      document_kind: "utility_bill",
      full_text: "Testville Power\nAmount due $61.40 by November 20, 2026.",
      sender: { text: "Testville Power", box_2d: [40, 60, 70, 400] },
      program: NIL,
      subject: NIL,
      asked: [{ text: "Pay the amount due", box_2d: [150, 60, 170, 400] }],
      deadlines: [{ text: "Amount due $61.40 by November 20, 2026.", box_2d: [200, 60, 220, 300] }],
      consequence: NIL,
      reference_no: NIL,
      notice_date: NIL,
      phones: [],
    });
    const reading = await read(bill);
    expect(answerReading(reading, "en", "2026-11-03").text).toContain("November 20, 2026");
    expect(documentsRead(reading).map((d) => d.kind)).toEqual([undefined]);
  });

  it("a letter naming a benefits program, called something else, keeps its deadline", async () => {
    const answer = answerReading(await read(pageJson({ document_kind: "utility_bill" })), "en", "2026-11-03");
    expect(answer.text).toMatch(/^This is a Medi-Cal renewal letter\. It is due November 20, 2026\./);
    expect(answer.deadlines.map((d) => d.dueDate)).toEqual(["2026-11-20"]);
  });

  it("a question that holds no date is not a duty, so a pay stub stays a pay stub", async () => {
    const reading = await read(
      pageJson({
        document_kind: "pay_stub",
        full_text: "Sample Works LLC\n400 Example Road, Testville, WA 98000\nEarnings Statement\nPay date: November 2, 2026\nNet pay $1,217.84",
        sender: { text: "Sample Works LLC", box_2d: [40, 60, 70, 400] },
        program: NIL,
        subject: NIL,
        asked: [],
        deadlines: [],
        consequence: NIL,
        reference_no: NIL,
        notice_date: NIL,
        phones: [],
      }),
    );
    expect(reading.questions.map((q) => q.kind)).toContain("confirm_deadline");
    expect(answerReading(reading, "en", "2026-11-03").text).toBe("This looks like a pay stub, and I could read it.");
    expect(documentsRead(reading).map((d) => d.kind)).toEqual(["pay_stub"]);
  });

  it("a reading with no kind answers as it always has", async () => {
    expect(answerReading(await read(RENEWAL_PAGE), "en", "2026-11-03").text).toMatch(/^This is a Medi-Cal renewal letter\./);
  });

  it("says what it is in every language Mano answers in, with no English in the others", async () => {
    const reading = await read(STUB);
    const lines = REPLY_LANGUAGES.map((language) => answerReading(reading, language).text);
    expect(lines[0]).toBe("This looks like a pay stub, and I could read it.");
    expect(new Set(lines).size).toBe(REPLY_LANGUAGES.length);
  });
});
