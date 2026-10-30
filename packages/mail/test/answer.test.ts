import { describe, expect, it } from "vitest";

import { answerReading, findInstructions, readMail } from "../src/index.js";
import {
  DOUBTFUL_PAGE,
  PLANTED_INSTRUCTION,
  PLANTED_PAGE,
  RENEWAL_PAGE,
  SCAM_PAGE,
  letterPhoto,
  pageJson,
  recordedReader,
} from "./letter-fixture.js";

async function answerFor(pages: string[]) {
  const model = recordedReader(pages);
  const reading = await readMail([{ bytes: await letterPhoto(), mimeType: "image/jpeg", name: "doc-1" }], {
    personId: "p1",
    synthetic: true,
    model,
  });
  return answerReading(reading);
}

describe("answerReading", () => {
  it("says what the letter is, its deadline with the letter's words, and what to send", async () => {
    const answer = await answerFor([RENEWAL_PAGE]);
    expect(answer.outcome).toBe("read");
    expect(answer.text).toContain("Sacramento County Medi-Cal Office");
    expect(answer.text).toContain("Renewal");
    expect(answer.text).toContain("November 20, 2026");
    expect(answer.text).toContain('"Your renewal is due November 20, 2026."');
    expect(answer.text).toContain("It asks you to: send the signed renewal form.");
    expect(answer.text).not.toContain("?");
    expect(answer.deadlines).toEqual([
      {
        letterId: "L1",
        file: "doc-1",
        title: "Medi-Cal renewal",
        kind: "renewal",
        dueDate: "2026-11-20",
        program: "Medi-Cal",
        federalProgram: "Medicaid",
        sentence: "Your renewal is due November 20, 2026.",
      },
    ]);
  });

  it("asks one question quoting the sentence when the gate does not publish the deadline", async () => {
    const answer = await answerFor([DOUBTFUL_PAGE]);
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toContain('"Your renewal is due November 20, 2026."');
    expect(answer.text.match(/\?/g)).toHaveLength(1);
    expect(answer.text).toMatch(/November 20, 2026[^.]*\?$/);
  });

  it("never repeats or follows an instruction planted in the letter, and says so", async () => {
    const answer = await answerFor([PLANTED_PAGE]);
    expect(answer.text).not.toContain(PLANTED_INSTRUCTION.slice(0, 30));
    expect(answer.text).not.toContain("300-4000");
    expect(findInstructions(answer.text)).toEqual([]);
    expect(answer.text).toContain("I did not follow");
    expect(answer.text).toContain("send the signed renewal form");
  });

  it("warns plainly about a scam letter and holds no deadline or request from it", async () => {
    const answer = await answerFor([SCAM_PAGE]);
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toMatch(/scam/i);
    expect(answer.text).not.toContain("November 20, 2026");
    expect(answer.text).not.toContain("send the signed renewal form");
    expect(answer.text).not.toMatch(/prepaid/i);
  });

  it("says honestly when nothing could be read, and offers to try again", async () => {
    const answer = await answerFor([pageJson({ readable: false, readability_note: "blurry", full_text: "" })]);
    expect(answer.outcome).toBe("unread");
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toMatch(/could not read/i);
    expect(answer.text).toMatch(/again/i);
  });

  it("says honestly when the reading failed", async () => {
    const answer = await answerFor([]);
    expect(answer.outcome).toBe("unread");
    expect(answer.text).toMatch(/could not/i);
    expect(answer.text).toMatch(/again/i);
  });
});

describe("answerReading wording", () => {
  it("drops a Re: prefix and list numbers from what the letter says", async () => {
    const answer = await answerFor([
      pageJson({
        subject: { text: "Re: Medi-Cal Renewal", box_2d: [110, 60, 130, 200] },
        full_text: "Sacramento County Medi-Cal Office\nRe: Medi-Cal Renewal\n1. Signed renewal form\n2. Proof of income\nYour renewal is due November 20, 2026.",
        asked: [
          { text: "1. Signed renewal form", box_2d: [150, 60, 170, 400] },
          { text: "2. Proof of income", box_2d: [175, 60, 190, 400] },
        ],
      }),
    ]);
    expect(answer.text).toContain("This is a letter from Sacramento County Medi-Cal Office: Medi-Cal Renewal.");
    expect(answer.text).toContain("It asks for: signed renewal form and proof of income.");
  });
});

describe("held deadline fields", () => {
  const withSentence = (sentence: string, program: string | null) =>
    pageJson({
      full_text: `County Office\n${program ?? ""}\nNotice date November 2, 2026\n\n${sentence}`,
      program: program ? { text: program, box_2d: [80, 60, 100, 200] } : { text: null, box_2d: null },
      subject: { text: null, box_2d: null },
      asked: [],
      consequence: { text: null, box_2d: null },
      reference_no: { text: null, box_2d: null },
      phones: [],
      deadlines: [{ text: sentence, box_2d: [200, 60, 220, 300] }],
    });

  it("takes the kind only from what the sentence says, and names the federal program", async () => {
    const proof = await answerFor([withSentence("Submit proof of income by November 20, 2026.", "CalFresh")]);
    expect(proof.deadlines).toEqual([expect.objectContaining({ kind: "documents", program: "CalFresh", federalProgram: "SNAP", title: "CalFresh documents" })]);
    const bare = await answerFor([withSentence("Respond by November 20, 2026.", "County Help Fund")]);
    expect(bare.deadlines).toEqual([expect.objectContaining({ kind: null, federalProgram: null, title: "County Help Fund" })]);
  });
});
