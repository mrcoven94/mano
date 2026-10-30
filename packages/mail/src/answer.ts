// What Mano tells the person about the mail it just read, built only
// from fields readMail cited on the letter. Per letter: what it is, the
// deadline when the gate publishes it (with the letter's own sentence),
// otherwise one question quoting that sentence, and what the letter asks
// the person to send. A scam letter gets a plain warning and nothing
// else from it. Text a letter aims at the reader is never repeated or
// followed, only mentioned. Links and phone numbers from the letter are
// never repeated: they are unchecked evidence.
import { scanContent } from "./safety.js";
import type { Letter, MailReading, Question, Warning } from "./types.js";

// What a held deadline is for, when the sentence says.
export type DeadlineKind = "renewal" | "recertification" | "interview" | "hearing" | "appeal" | "payment" | "documents";

// A deadline the gate published: Mano holds it without asking.
export interface HeldDeadline {
  letterId: string;
  // The InputFile name its sentence is cited on.
  file: string;
  // Short and plain ("Medi-Cal renewal"); never quoted to the person.
  title: string;
  kind: DeadlineKind | null;
  dueDate: string;
  // The program as the letter names it, and its federal name when Mano
  // knows it ("Medi-Cal" is Medicaid).
  program: string | null;
  federalProgram: string | null;
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

// A field as Mano says it: no list number or "Re:" in front, no
// trailing punctuation.
const bare = (value: string): string =>
  value
    .trim()
    .replace(/^(?:\(?\d{1,2}[.)]|[-*\u2022]|re:)\s*/i, "")
    .replace(/[\s.;:,]+$/, "");

// Whether Mano may repeat a piece of this letter. Nothing the reader's own
// scan flags (an instruction, a link, a phone number) and no contact the
// letter carries, however it is written: Mano recommends no phone number,
// link or address from a letter.
type Speakable = (value: string) => boolean;
const CONTACT_WARNINGS = new Set(["phone_unchecked", "link_unchecked", "address_unchecked", "instruction_in_content"]);
const digits = (value: string): string => value.replace(/\D/g, "");

function speakableFor(warnings: Warning[]): Speakable {
  const contacts = warnings.filter((w) => CONTACT_WARNINGS.has(w.kind) && w.detail).map((w) => w.detail!.toLowerCase());
  return (value) => {
    if (scanContent(value).length > 0) return false;
    const lower = value.toLowerCase();
    const valueDigits = digits(value);
    return !contacts.some((c) => lower.includes(c) || (digits(c).length >= 7 && valueDigits.includes(digits(c))));
  };
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const SCAM =
  "This letter looks like a scam. Do not pay, call, or open anything it lists. If you are not sure, call your office at a number you already trust.";
const PLANTED = "Part of this letter tries to give me instructions. I did not follow them.";
const UNREAD = "I could not read the letter in your photo. Send it again with the whole page flat, in good light, and I will try once more.";
const FAILED = "I could not finish reading your photo just now. Send it again and I will try once more.";
const OFFICIAL = "If you need to call the office, use the number on your state's official site, not one from a letter.";

const IMPERATIVE = /^(send|bring|return|sign|submit|provide|mail|complete|fill|call|upload|attach|include|keep|make|pay|renew|report|apply|reply|respond)\b/i;
const lowerFirst = (item: string): string => (/^[A-Z][a-z]/.test(item) ? item[0]!.toLowerCase() + item.slice(1) : item);

// "It asks you to: send ..." when every item is an instruction, else
// "It asks for: ...".
function askedLine(asked: string[]): string {
  const items = asked.map(lowerFirst);
  return asked.every((a) => IMPERATIVE.test(a)) ? `It asks you to: ${listOf(items)}.` : `It asks for: ${listOf(items)}.`;
}

function whatItIs(letter: Letter, safe: Speakable): string {
  const f = letter.fields;
  const sender = f.sender && safe(f.sender.value) ? bare(f.sender.value) : null;
  const subject = [f.subject, f.program].find((c) => c && safe(c.value));
  const what = subject ? bare(subject!.value) : null;
  if (sender && what) return `This is a letter from ${sender}: ${what}.`;
  if (what) return `The letter is titled "${what}".`;
  if (sender) return `This is a letter from ${sender}.`;
  return "I read this letter, but it does not say clearly who sent it or what it is about.";
}

// The letter's words in quotes, closed with a period outside the quote
// when the sentence has none of its own.
const quoted = (quote: string): string => (/[.!?]$/.test(quote.trim()) ? `"${quote.trim()}"` : `"${quote.trim()}".`);

// A sentence Mano may not repeat is never quoted and never held: the
// date goes in Mano's own words, as a question.
const unquoted = (iso: string): string => `It looks like the letter gives a deadline of ${spoken(iso)}. Is that the date you need to meet?`;

function deadlineLine(question: Question | undefined, safe: Speakable): { text: string; held: boolean } | null {
  if (!question) return null;
  const proposal = question.proposal;
  if (proposal && !safe(proposal.quote)) return { text: unquoted(proposal.dueDate), held: false };
  if (proposal?.confidence === "high") {
    return { text: `It is due ${spoken(proposal.dueDate)}. The letter says: ${quoted(proposal.quote)}`, held: true };
  }
  if (proposal) {
    return { text: `The letter says: ${quoted(proposal.quote)} Is ${spoken(proposal.dueDate)} the date you need to meet?`, held: false };
  }
  // Only a sentence that names a date is worth asking about.
  const candidate = question.candidates?.find((c) => c.dates.length > 0);
  if (!candidate) return null;
  if (!safe(candidate.sentence)) return { text: unquoted(candidate.dates[0]!), held: false };
  return { text: `The letter says: ${quoted(candidate.sentence)} Which date is your deadline?`, held: false };
}

// Only what the published sentence says; no kind when it says none.
function kindOf(sentence: string, obligation: string): DeadlineKind | null {
  const t = sentence.toLowerCase();
  if (/\brecertif/.test(t)) return "recertification";
  if (/\binterview\b/.test(t)) return "interview";
  if (/\bhearing\b/.test(t)) return "hearing";
  if (/\bappeal\b/.test(t)) return "appeal";
  if (obligation === "renew" && /\b(renew|renewal)\b/.test(t)) return "renewal";
  if (obligation === "pay") return "payment";
  if (obligation === "respond" && /\b(proofs?|documents?|forms?|pay stubs?|paperwork|records?|statements?|receipts?)\b/.test(t)) return "documents";
  return null;
}

// State names for federal programs, and the federal names themselves.
const FEDERAL: [RegExp, string][] = [
  [/^(snap|calfresh|food stamps|basic food|food assistance)\b/i, "SNAP"],
  [/^(medicaid|medi-cal|masshealth|apple health|tenncare|soonercare|badgercare)\b/i, "Medicaid"],
  [/^(tanf|calworks|cash assistance)\b/i, "TANF"],
  [/^(wic)\b/i, "WIC"],
  [/^(ssi|supplemental security income)\b/i, "SSI"],
  [/^(liheap)\b/i, "LIHEAP"],
  [/^(housing choice voucher|section 8)\b/i, "Housing Choice Voucher"],
];
function federalOf(program: string | null): string | null {
  if (!program) return null;
  return FEDERAL.find(([re]) => re.test(program.trim()))?.[1] ?? null;
}

function titleOf(letter: Letter, kind: DeadlineKind | null): string {
  const program = letter.fields.program ? bare(letter.fields.program.value) : null;
  if (program && kind) return `${program} ${kind}`;
  if (kind) return kind.charAt(0).toUpperCase() + kind.slice(1);
  return bare(program ?? letter.fields.subject?.value ?? "Letter deadline");
}

function letterAnswer(reading: MailReading, letter: Letter): { lines: string[]; held: HeldDeadline | null } {
  const warnings = reading.warnings.filter((w) => w.letterId === letter.id);
  if (warnings.some((w) => w.kind === "scam_suspect")) return { lines: [SCAM], held: null };
  const safe = speakableFor(warnings);
  const lines = [whatItIs(letter, safe)];
  const question = reading.questions.find((q) => q.letterId === letter.id && q.kind === "confirm_deadline");
  const deadline = deadlineLine(question, safe);
  const proposal = question?.proposal;
  const held =
    deadline?.held && proposal
      ? {
          letterId: letter.id,
          file: proposal.citation.file,
          title: titleOf(letter, kindOf(proposal.quote, proposal.obligation)),
          kind: kindOf(proposal.quote, proposal.obligation),
          dueDate: proposal.dueDate,
          program: letter.fields.program ? bare(letter.fields.program.value) : null,
          federalProgram: federalOf(letter.fields.program ? bare(letter.fields.program.value) : null),
          sentence: proposal.quote,
        }
      : null;
  const asked = letter.fields.asked.map((a) => a.value).filter(safe).map(bare);
  if (asked.length > 0) lines.push(askedLine(asked));
  if (warnings.some((w) => w.kind === "instruction_in_content")) lines.push(PLANTED);
  if (warnings.some((w) => w.kind === "phone_unchecked" || w.kind === "link_unchecked")) lines.push(OFFICIAL);
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
