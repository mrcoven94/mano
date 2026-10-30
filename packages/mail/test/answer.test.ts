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
    expect(answer.text).toContain("Send the signed renewal form");
    expect(answer.text).not.toContain("?");
    expect(answer.deadlines).toEqual([
      {
        letterId: "L1",
        file: "doc-1",
        title: "Renewal",
        dueDate: "2026-11-20",
        program: "Medi-Cal",
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
    expect(answer.text).toContain("Send the signed renewal form");
  });

  it("warns plainly about a scam letter and holds no deadline or request from it", async () => {
    const answer = await answerFor([SCAM_PAGE]);
    expect(answer.deadlines).toEqual([]);
    expect(answer.text).toMatch(/scam/i);
    expect(answer.text).not.toContain("November 20, 2026");
    expect(answer.text).not.toContain("Send the signed renewal form");
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
