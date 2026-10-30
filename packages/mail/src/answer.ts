// What Mano tells the person about the mail it just read, built only
// from fields readMail cited on the letter. Per letter: what it is, the
// deadline when the gate publishes it (with the letter's own sentence),
// otherwise one question quoting that sentence, and what the letter asks
// the person to send. A scam letter gets a plain warning and nothing
// else from it. Text a letter aims at the reader is never repeated or
// followed, only mentioned. Links and phone numbers from the letter are
// never repeated: they are unchecked evidence.
import { findInstructions } from "./safety.js";
import type { Letter, MailReading, Question } from "./types.js";

// A deadline the gate published: Mano holds it without asking.
export interface HeldDeadline {
  letterId: string;
  // The InputFile name its sentence is cited on.
  file: string;
  title: string;
  dueDate: string;
  program: string | null;
  // The letter's sentence, verbatim.
  sentence: string;
}

export interface MailAnswer {
  // "unread" when no letter could be read from the files.
  outcome: "read" | "unread";
  text: string;
  deadlines: HeldDeadline[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function spoken(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

const bare = (value: string): string => value.trim().replace(/[\s.;:,]+$/, "");
const PHONE_OR_LINK = /\d{3}[-.\s)]+\d{3,4}|https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,24}\//i;
const safe = (value: string): boolean => findInstructions(value).length === 0 && !PHONE_OR_LINK.test(value);

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const SCAM =
  "This letter looks like a scam. Do not pay, call, or open anything it lists. If you are not sure, call your office at a number you already trust.";
const PLANTED = "Part of this letter tries to give me instructions. I did not follow them.";
const UNREAD = "I could not read the letter in your photo. Send it again with the whole page flat, in good light, and I will try once more.";
const FAILED = "I could not finish reading your photo just now. Send it again and I will try once more.";

function whatItIs(letter: Letter): string {
  const f = letter.fields;
  const sender = f.sender && safe(f.sender.value) ? bare(f.sender.value) : null;
  const subject = [f.subject, f.program].find((c) => c && safe(c.value));
  const what = subject ? bare(subject!.value) : null;
  if (sender && what) return `This is a letter from ${sender}: ${what}.`;
  if (what) return `This is a letter about ${what}.`;
  if (sender) return `This is a letter from ${sender}.`;
  return "I read this letter, but it does not say clearly who sent it or what it is about.";
}

function deadlineLine(question: Question | undefined): { text: string; held: boolean } | null {
  if (!question) return null;
  const proposal = question.proposal;
  if (proposal?.confidence === "high") {
    return { text: `It is due ${spoken(proposal.dueDate)}. The letter says: "${proposal.quote}"`, held: true };
  }
  if (proposal) {
    return { text: `The letter says: "${proposal.quote}" Is ${spoken(proposal.dueDate)} the date you need to meet?`, held: false };
  }
  const sentence = question.candidates?.[0]?.sentence;
  if (sentence) return { text: `The letter says: "${bare(sentence)}." Which date is your deadline?`, held: false };
  return null;
}

function letterAnswer(reading: MailReading, letter: Letter): { lines: string[]; held: HeldDeadline | null } {
  const warnings = reading.warnings.filter((w) => w.letterId === letter.id);
  if (warnings.some((w) => w.kind === "scam_suspect")) return { lines: [SCAM], held: null };
  const lines = [whatItIs(letter)];
  const question = reading.questions.find((q) => q.letterId === letter.id && q.kind === "confirm_deadline");
  const deadline = deadlineLine(question);
  const proposal = question?.proposal;
  const held =
    deadline?.held && proposal
      ? {
          letterId: letter.id,
          file: proposal.citation.file,
          title: bare(letter.fields.subject?.value ?? letter.fields.program?.value ?? letter.fields.sender?.value ?? "Letter deadline"),
          dueDate: proposal.dueDate,
          program: letter.fields.program ? bare(letter.fields.program.value) : null,
          sentence: proposal.quote,
        }
      : null;
  const asked = letter.fields.asked.map((a) => a.value).filter(safe).map(bare);
  if (asked.length > 0) lines.push(`What to do: ${listOf(asked)}.`);
  if (warnings.some((w) => w.kind === "instruction_in_content")) lines.push(PLANTED);
  // The question goes last, so the reply ends on the one thing to answer.
  if (deadline) {
    if (held) lines.splice(1, 0, deadline.text);
    else lines.push(deadline.text);
  }
  return { lines, held };
}

// A letter with nothing read from it: every page failed or was unreadable.
function wasRead(letter: Letter): boolean {
  const f = letter.fields;
  return f.excerpt.trim().length > 0 || f.asked.length > 0 || [f.sender, f.program, f.subject, f.deadlineText].some(Boolean);
}

export function answerReading(reading: MailReading): MailAnswer {
  const read = reading.letters.filter(wasRead);
  const failed = reading.questions.some((q) => q.kind === "read_failed" || q.kind === "budget_exceeded");
  if (read.length === 0) return { outcome: "unread", text: failed ? FAILED : UNREAD, deadlines: [] };
  const answers = read.map((letter) => letterAnswer(reading, letter));
  const paragraphs = answers.map((a, i) => (answers.length > 1 ? `Letter ${i + 1}. ${a.lines.join(" ")}` : a.lines.join(" ")));
  const missed = read.length < reading.letters.length || reading.questions.some((q) => q.letterId === null && q.kind !== "video_truncated");
  if (missed) paragraphs.push("I could not read part of what you sent. Send that photo again if it had another letter.");
  return {
    outcome: "read",
    text: paragraphs.join("\n\n"),
    deadlines: answers.flatMap((a) => (a.held ? [a.held] : [])),
  };
}
