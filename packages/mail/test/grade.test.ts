import { describe, expect, it } from "vitest";
import { isPhotoOk, scorePhoto, type GradeTruth } from "../src/grade.js";
import type { DateToKnow, Letter, MailReading, Question, Warning } from "../src/types.js";

const box = { ymin: 10, xmin: 10, ymax: 30, xmax: 200 };
const cite = (file: string) => ({ file, page: 1, box });

type TruthLetter = GradeTruth["letters"][number];

function truthLetter(over: Partial<TruthLetter> = {}): TruthLetter {
  return {
    id: "mail-01",
    sender: "County Office",
    program: "Medi-Cal",
    referenceNo: "CA-1",
    deadlineIso: "2026-11-20",
    scam: false,
    plantedInstruction: false,
    phones: ["(555) 100-2000"],
    links: [],
    asked: ["signed renewal form"],
    ...over,
  };
}

function truth(letters: TruthLetter[], questions: GradeTruth["questions"] = []): GradeTruth {
  return { file: "photo.jpg", questions, letters };
}

function foundLetter(
  file: string,
  fieldsOver: Partial<Letter["fields"]> = {},
  letterOver: Partial<Letter> = {},
): Letter {
  return {
    id: "L1",
    pages: [{ page: 1, file, crop: box, width: 500, height: 600, frameTimeMs: 0, rotationDegrees: 0 }],
    fields: {
      sender: { value: "County Office", citation: cite(file) },
      program: { value: "Medi-Cal", citation: cite(file) },
      subject: null,
      asked: [{ value: "signed renewal form", citation: cite(file) }],
      deadlineText: { value: "November 20, 2026", citation: cite(file) },
      consequence: null,
      referenceNo: { value: "CA-1", citation: cite(file) },
      noticeDate: null,
      contacts: [],
      excerpt: "",
      ...fieldsOver,
    },
    ...letterOver,
  };
}

// A confirm_deadline question carrying a proposal: Mail never publishes
// a deadline, so deadlines are graded on proposals.
function proposal(file: string, dueDate: string, confidence: "high" | "low" = "high", letterId = "L1"): Question {
  return {
    id: `Q-${dueDate}`,
    kind: "confirm_deadline",
    letterId,
    prompt: "hold this date?",
    citation: cite(file),
    proposal: {
      letterId,
      sentence: `Respond by ${dueDate}`,
      quote: `Respond by ${dueDate}.`,
      citation: cite(file),
      dueDate,
      obligation: "respond",
      confidence,
      count: null,
      reasons: [],
      others: [],
    },
  };
}

function dateToKnow(file: string, date: string): DateToKnow {
  return { letterId: "L1", program: "Medi-Cal", date, dateText: date, quote: `Coverage ends ${date}.`, citation: cite(file) };
}

function phoneWarning(file: string, phone: string): Warning {
  return { kind: "phone_unchecked", message: "phone", letterId: "L1", citation: cite(file), detail: phone };
}

function reading(over: {
  letters?: Letter[];
  proposals?: Question[];
  datesToKnow?: DateToKnow[];
  warnings?: Warning[];
  questions?: Question[];
}): MailReading {
  return {
    letters: over.letters ?? [],
    datesToKnow: over.datesToKnow ?? [],
    warnings: over.warnings ?? [],
    questions: [...(over.proposals ?? []), ...(over.questions ?? [])],
    stats: { files: 1, frames: 1, pages: 1, modelCalls: [], inputTokens: 10, outputTokens: 5, elapsedMs: 100, live: false },
  };
}

describe("scorePhoto", () => {
  it("keeps key denominators when a letter is dropped", () => {
    const t = truth([
      truthLetter({ id: "mail-01", sender: "Office A", phones: ["(555) 100-2000"], asked: ["signed renewal form"] }),
      truthLetter({ id: "mail-02", sender: "Office B", phones: ["(555) 200-3000"], asked: ["photo ID"] }),
    ]);
    const r = reading({
      letters: [foundLetter("photo.jpg", { sender: { value: "Office A", citation: cite("photo.jpg") } })],
      proposals: [proposal("photo.jpg", "2026-11-20")],
      warnings: [phoneWarning("photo.jpg", "(555) 100-2000")],
    });
    const score = scorePhoto(t, r, 100);
    expect(score.lettersCorrect).toBe(false);
    expect(score.askedExpected).toBe(2);
    expect(score.askedFound).toBe(1);
    expect(score.contactsExpected).toBe(2);
    expect(score.contactsWarned).toBe(1);
  });

  it("fails an extra invented proposal", () => {
    const t = truth([truthLetter()]);
    const r = reading({
      letters: [foundLetter("photo.jpg")],
      proposals: [proposal("photo.jpg", "2026-11-20"), proposal("photo.jpg", "2099-01-01", "low", "L2")],
      warnings: [phoneWarning("photo.jpg", "(555) 100-2000")],
    });
    const score = scorePhoto(t, r, 100);
    expect(score.deadlinesCorrect).toBe(false);
    expect(score.notes).toContain("extra proposal: 2099-01-01");
  });

  it("fails a missing deadline", () => {
    const t = truth([truthLetter()]);
    const r = reading({
      letters: [foundLetter("photo.jpg")],
      warnings: [phoneWarning("photo.jpg", "(555) 100-2000")],
    });
    const score = scorePhoto(t, r, 100);
    expect(score.deadlinesCorrect).toBe(false);
    expect(score.notes).toContain("proposal missing: 2026-11-20");
  });

  it("counts proposals and the high-confidence ones", () => {
    const t = truth([truthLetter()], ["confirm_deadline"]);
    const r = reading({
      letters: [foundLetter("photo.jpg")],
      proposals: [proposal("photo.jpg", "2026-11-20", "high"), proposal("photo.jpg", "2026-11-20", "low", "L2")],
      warnings: [phoneWarning("photo.jpg", "(555) 100-2000")],
      questions: [{ id: "Q9", kind: "confirm_deadline", letterId: "L3", prompt: "which date?", citation: null }],
    });
    const score = scorePhoto(t, r, 100);
    expect(score.proposals).toBe(2);
    expect(score.proposalsHigh).toBe(1);
  });
});

describe("isPhotoOk", () => {
  function clean(): { t: GradeTruth; r: MailReading } {
    return {
      t: truth([truthLetter()]),
      r: reading({
        letters: [foundLetter("photo.jpg")],
        proposals: [proposal("photo.jpg", "2026-11-20")],
        warnings: [phoneWarning("photo.jpg", "(555) 100-2000")],
      }),
    };
  }

  it("passes a fully correct photo", () => {
    const { t, r } = clean();
    expect(isPhotoOk(scorePhoto(t, r, 100))).toBe(true);
  });

  it("fails when a scam goes unflagged", () => {
    const { t, r } = clean();
    t.letters[0]!.scam = true;
    expect(isPhotoOk(scorePhoto(t, r, 100))).toBe(false);
  });

  it("fails when a planted instruction goes unflagged", () => {
    const { t, r } = clean();
    t.letters[0]!.plantedInstruction = true;
    expect(isPhotoOk(scorePhoto(t, r, 100))).toBe(false);
  });

  it("fails a proposal with the wrong date", () => {
    const { t, r } = clean();
    r.questions = [proposal("photo.jpg", "2026-11-21")];
    const score = scorePhoto(t, r, 100);
    expect(score.deadlinesCorrect).toBe(false);
    expect(score.fieldsCorrect).toBe(score.fieldsExpected - 1);
    expect(isPhotoOk(score)).toBe(false);
  });

  it("counts and citation-checks dates to know", () => {
    const { t, r } = clean();
    r.datesToKnow = [
      { ...dateToKnow("photo.jpg", "2026-12-20"), citation: { file: "photo.jpg", page: 1, box: { ymin: 0, xmin: 0, ymax: 1, xmax: 1 } } },
    ];
    const score = scorePhoto(t, r, 100);
    expect(score.datesToKnow).toBe(1);
    expect(score.citationsCited).toBe(score.citationsChecked - 1);
    expect(score.notes.some((n) => n.includes("date-to-know[0] published without a real citation box"))).toBe(true);
    expect(isPhotoOk(score)).toBe(false);
  });
});
