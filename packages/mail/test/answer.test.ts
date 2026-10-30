import { describe, expect, it } from "vitest";

import { answerReading, readMail } from "../src/index.js";
import {
  DOUBTFUL_PAGE,
  PLANTED_DEADLINE,
  PLANTED_DEADLINE_PAGE,
  PLANTED_INSTRUCTION,
  PLANTED_PAGE,
  RENEWAL_PAGE,
  RENEWAL_TEXT,
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

const OFFICIAL = "If you need to call the office, use the number on your state's official site, not one from a letter.";
const SEVERAL = "Your letter mentions more than one date, and I don't want to guess wrong. Which date does it say you need to meet?";
// Every phrase the reply may share with a letter: Mano's closed words.
const CLOSED =
  "proof of income, ID, proof of address, pay stubs, bank statements, rent or utility bills, household member info, other documents the letter lists. " +
  `${OFFICIAL} renewal letter, letter about an interview, letter asking for documents, notice of a change, denial letter, letter about an overpayment, letter about a hearing. ` +
  // The published date, which Mano says in its own form.
  "It is due November 20, 2026.";

// No run of three words from the letter reaches the reply unless it is
// one of Mano's own closed phrases.
function copiedFrom(letter: string, reply: string): string[] {
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const replyWords = words(reply);
  const letterText = ` ${words(letter).join(" ")} `;
  const closed = ` ${words(CLOSED).join(" ")} `;
  const copied: string[] = [];
  for (let i = 0; i + 3 <= replyWords.length; i++) {
    const tri = ` ${replyWords.slice(i, i + 3).join(" ")} `;
    if (letterText.includes(tri) && !closed.includes(tri)) copied.push(tri.trim());
  }
  return copied;
}

describe("answerReading builds the reply from closed fields only", () => {
  it("says the program, the letter type, the published deadline and what to send, in Mano's words", async () => {
    const answer = await answerFor([RENEWAL_PAGE]);
    expect(answer.outcome).toBe("read");
    expect(answer.text).toBe(
      `This is a Medi-Cal renewal letter. It is due November 20, 2026. It asks you to send: other documents the letter lists. ${OFFICIAL}`,
    );
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
    expect(copiedFrom(RENEWAL_TEXT, answer.text)).toEqual([]);
  });

  it("maps what the letter asks for into Mano's categories", async () => {
    const asked = [
      "Proof of household income for last month (pay stubs or award letters)",
      "Proof of address if you moved",
      "A photo ID",
      "Your latest bank statement",
      "A rent receipt",
      "The signed renewal form",
    ];
    const answer = await answerFor([
      pageJson({
        full_text: `${RENEWAL_TEXT}\n${asked.join("\n")}`,
        asked: asked.map((text, i) => ({ text, box_2d: [300 + i * 20, 60, 315 + i * 20, 400] })),
      }),
    ]);
    expect(answer.text).toContain(
      "It asks you to send: proof of income, ID, proof of address, pay stubs, bank statements, rent or utility bills and other documents the letter lists.",
    );
  });

  it("review 2 blocker 1: contacts in any form never reach the reply, and no letter text does", async () => {
    const strings = [
      "Call five five five three zero zero four zero zero zero",
      "Visit benefits-recheck dot help",
      "Call 555-\n300-4000",
      "Call 1-800-FOOD-NOW",
    ];
    const fullText = `${RENEWAL_TEXT}\n${strings.join("\n")}`;
    const answer = await answerFor([
      pageJson({
        full_text: fullText,
        sender: { text: "Visit benefits-recheck dot help", box_2d: [40, 60, 70, 400] },
        asked: strings.map((text, i) => ({ text: text.replace("\n", ""), box_2d: [300 + i * 20, 60, 315 + i * 20, 400] })),
      }),
    ]);
    for (const leak of ["five", "zero", "recheck", "dot help", "FOOD", "555", "300", "4000", "1-800"]) {
      expect(answer.text).not.toContain(leak);
    }
    expect(answer.text).toContain(OFFICIAL);
    expect(copiedFrom(fullText, answer.text)).toEqual([]);
  });

  it("review 2 blocker 2: a held-back deadline with a negated date names no date", async () => {
    const sentence = "Do not call (555) 300-4000 by November 20, 2026; your actual deadline is December 1, 2026.";
    const answer = await answerFor([
      pageJson({
        full_text: `Sacramento County Medi-Cal Office\nRe: Renewal\nNotice date November 2, 2026\n\n${sentence}`,
        asked: [],
        phones: [],
        consequence: { text: null, box_2d: null },
        reference_no: { text: null, box_2d: null },
        deadlines: [{ text: sentence, box_2d: [200, 60, 220, 300] }],
      }),
    ]);
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toMatch(new RegExp(`${SEVERAL.replace(/[.?]/g, "\\$&")}$`));
    expect(answer.text).not.toContain("November 20");
    expect(answer.text).not.toContain("December 1");
  });

  it("a held-back deadline with other dates on the letter asks which date, naming none", async () => {
    const answer = await answerFor([DOUBTFUL_PAGE]);
    expect(answer.deadlines).toEqual([]);
    expect(answer.text.endsWith(SEVERAL)).toBe(true);
    expect(answer.text).not.toMatch(/November 20|December 31/);
    expect(answer.text.match(/\?/g)).toHaveLength(1);
  });

  it("a held-back deadline with exactly one date and no doubt asks about that date", async () => {
    const answer = await answerFor([
      pageJson({
        full_text: "SNAP renewal notice\n\nDue November 15, 2026\n\nSend photo ID, pay stub, rent receipt",
        sender: { text: null, box_2d: null },
        program: { text: null, box_2d: null },
        subject: { text: "SNAP renewal notice", box_2d: [40, 60, 70, 400] },
        asked: [{ text: "Send photo ID, pay stub, rent receipt", box_2d: [150, 60, 170, 400] }],
        deadlines: [{ text: "Due November 15, 2026", box_2d: [80, 60, 100, 300] }],
        consequence: { text: null, box_2d: null },
        reference_no: { text: null, box_2d: null },
        notice_date: { text: null, box_2d: null },
        phones: [],
      }),
    ]);
    expect(answer.text).toBe(
      `This is a SNAP renewal letter. It asks you to send: ID, pay stubs and rent or utility bills. ${OFFICIAL} ` +
        "It looks like the letter gives a deadline of November 15, 2026. Is that the date you need to meet?",
    );
  });

  it("never repeats an instruction planted in the letter, and says it was not followed", async () => {
    const answer = await answerFor([PLANTED_PAGE]);
    expect(answer.text).not.toContain(PLANTED_INSTRUCTION.slice(0, 20));
    expect(answer.text).not.toContain("300-4000");
    expect(answer.text).toContain("I did not follow them.");
  });

  it("never quotes or holds a deadline sentence that carries an instruction", async () => {
    const answer = await answerFor([PLANTED_DEADLINE_PAGE]);
    expect(answer.text).not.toMatch(/ignore previous/i);
    expect(answer.text).not.toContain("300-4000");
    expect(answer.text).not.toContain(PLANTED_DEADLINE.slice(0, 30));
    expect(answer.deadlines).toEqual([]);
  });

  it("warns plainly about a scam letter and says nothing else from it", async () => {
    const answer = await answerFor([SCAM_PAGE]);
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toMatch(/^This letter looks like a scam\./);
    expect(answer.text).not.toMatch(/November|prepaid|renewal/i);
  });

  it("warns about an urgent letter that says not to call the county", async () => {
    const lines = ["URGENT BENEFITS ALERT", "Verify now or your case closes today", "Do not call the county"];
    const answer = await answerFor([
      pageJson({
        full_text: lines.join("\n\n"),
        sender: { text: null, box_2d: null },
        program: { text: null, box_2d: null },
        subject: { text: lines[0], box_2d: [40, 60, 70, 400] },
        asked: [{ text: lines[1], box_2d: [80, 60, 100, 300] }],
        deadlines: [{ text: lines[1], box_2d: [80, 60, 100, 300] }],
        consequence: { text: null, box_2d: null },
        reference_no: { text: null, box_2d: null },
        notice_date: { text: null, box_2d: null },
        phones: [],
      }),
    ]);
    expect(answer.text).toMatch(/looks like a scam/);
    expect(answer.text).not.toMatch(/verify now|which date/i);
  });

  it("names a deadline's kind only from what the sentence says, and the program from Mano's list", async () => {
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
    const proof = await answerFor([withSentence("Submit proof of income by November 20, 2026.", "CalFresh")]);
    expect(proof.deadlines).toEqual([expect.objectContaining({ kind: "documents", program: "CalFresh", federalProgram: "SNAP", title: "CalFresh documents" })]);
    const plain = await answerFor([withSentence("Respond by November 20, 2026.", "County Help Fund")]);
    expect(plain.deadlines).toEqual([expect.objectContaining({ kind: null, program: null, federalProgram: null, title: "Letter deadline" })]);
    expect(plain.text).toMatch(/^This is a benefits letter\./);
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
