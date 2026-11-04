// Which date the first reply about a letter may name, as a question the person
// checks. The reader decides which date the person must meet, because a letter
// can say so in words no rule list would cover. Code then checks that answer
// against the letter and applies the vetoes below. Naming is not holding:
// nothing here reaches a deadline record, and only the gate's grammar in gate.ts
// holds a date. A reader that says nothing, or an answer that fails a check,
// names no date.
import { normalizeMonthAbbreviations, parseAllDates, parseWrittenDate, splitSentences, verbatimSentences } from "./dates.js";
import { NAMED_HEADING, chronologyOf, gateSentence } from "./gate.js";
import type { ReaderDates } from "./read.js";
import type { NamedDate, NamedDates } from "./types.js";

const SPACE = / /g;
const phrases = (list: string[]): string => list.map((w) => w.replace(SPACE, String.raw`\s+`)).join("|");

const CONDITION_OPENING = /^(?:if|when|unless|once|should|in\s+case)\b/i;

// Wording that says a letter is someone else's, is no one's, or no longer
// stands. Kept narrow, since letters mention other people and forms all the
// time: every hit costs an ordinary letter its named date.
const NOT_THEIRS = new RegExp(
  String.raw`\b(?:${phrases([
    "(?:notice|letter|instructions|this) (?:\\w+ ){0,4}addressed to (?!you\\b)",
    "copy of (?:the|a|an) (?:letter|notice) (?:sent|mailed|addressed)",
    "(?:sent|mailed|delivered|issued) to (?:your (?!address|home|mailing|last|current)|another )",
    "(?:notice|letter) (?:was |is )?(?:intended|meant) for", "not for you", "does not concern", "this is a test", "this is an example", "specimen",
    "(?<!\\.)(?:sample|example|practice|training|template) (?:letter|notice)", "for training use", "template for",
  ])})\b|^(?:copy|duplicate|sample|(?:file|office|courtesy|agency|county) copy)$`,
  "i",
);
// Read only outside a condition: "if you already sent it, disregard this" is on
// ordinary letters, and the person can answer it.
const NO_LONGER_STANDS = new RegExp(
  String.raw`\b(?:${phrases([
    "cancel+ed", "withdrawn", "rescinded", "void", "disregard", "sent in error", "by mistake", "superseded",
    "(?:corrected|revised|amended) notice", "(?:notice|letter|deadline|date|this) (?:\\w+ ){0,3}(?:does|do) not apply", "no longer (?:apply|applies|needed|required)",
    "need not", "no need to", "exempt(?:ed)?", "excused", "waived",
    "(?:you|household) (?:do|does) not (?:need|have) to (?:return|send|respond|reply|sign|submit|renew|do)", "you don['’]t (?:need|have) to (?:return|send|respond|reply|sign|submit|renew|do)",
  ])})\b`,
  "i",
);
const ABOUT_SOMEONE_ELSE = /\b(?:notice|letter)\b.*\b(?:someone else|another (?:person|household))\b/i;
const THIS_IS_FOR = /^[Tt]his\s+(?:letter|notice)\s+is\s+for\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$|^[Ii]nstructions\s+for\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$/;
const ADDRESSEE_LINE = /^(?:to|attn|attention|cc|addressee|recipient)\s*:\s*([A-Z][\w'-]+\s+[A-Z][\w'-]+)\.?$/i;
// A heading the gate reads as a name can be the letter's subject instead.
const LETTER_SUBJECT = /\b(?:renewal|recertification|notice|review|benefits?|account|case|deadline|interview|coverage|change|denial|approval|due)\b/i;
const SALUTATION = /^\s*dear\s+[^\n]{1,60}$/gim;
const SALUTATION_END = /[\s:,]+$/;
const HEADING_LEAD = /^(?:(?:notice|letter)\s+)?(?:for|re:)\s*/i;
const HEADING_END = /[.:]$/;

function appearsTwice(text: string, name: string): boolean {
  return text.split(name).length > 2;
}

function notTheirs(letterText: string, sentences: string[], verbatim: string[]): boolean {
  const salutations = new Set((letterText.match(SALUTATION) ?? []).map((s) => s.trim().toLowerCase().replace(SALUTATION_END, "")));
  if (salutations.size > 1) return true;
  const otherPerson = (raw: string): boolean => {
    const line = raw.trim().replace(HEADING_END, "");
    const addressee = line.match(ADDRESSEE_LINE)?.[1];
    if (addressee) return !LETTER_SUBJECT.test(addressee) && !appearsTwice(letterText, addressee);
    if (!NAMED_HEADING.test(line)) return false;
    const name = line.replace(HEADING_LEAD, "");
    return !LETTER_SUBJECT.test(name) && !appearsTwice(letterText, name);
  };
  return verbatim.some(otherPerson) || sentences.some((s) => NOT_THEIRS.test(s) || THIS_IS_FOR.test(s) || (!CONDITION_OPENING.test(s) && (NO_LONGER_STANDS.test(s) || ABOUT_SOMEONE_ELSE.test(s))));
}

// A sentence that changes the date. The date it moves to is the only one Mano
// may name, and only when that is the date the reader chose.
const MOVES_THE_DATE = new RegExp(
  String.raw`\b(?:${phrases([
    "(?:have|has|given) until", "(?:extended|moved|changed|postponed|pushed) (?:to|until)", "(?:has|have) been (?:extended|postponed|rescheduled|moved|changed)",
    "(?:has|have) extended", "was postponed", "now due", "grace period", "new (?:date|deadline|due date)",
  ])})\b`,
  "i",
);
// A heading that reverses what follows it, or a sentence that does.
const REVERSES = /^(?:do\s+not|don['’]t|never)\b[^.]*:$|^instead\b/i;
// "If we do not hear from you by" is the date to meet. "Do not return it by" is not.
const NEGATED = /^(?:please\s+)?(?:do\s+not|don['’]t|never)\b/i;
const COUNTED = /\b(?:within|in)\s+\S+\s+(?:\w+\s+)?(?:days?|weeks?|months?)\b/i;
const PROOF_OF_PAYMENT = /\b(?:proof|copy|copies|receipt|evidence)\s+of\b/i;
const LIST_MARKER = /^[-*•]\s*/;
const WHITESPACE_RUN = /\s+/g;
const ENDING_MARKS = /[\s.!;:,]+$/;

function normal(text: string): string {
  return normalizeMonthAbbreviations(text).replace(WHITESPACE_RUN, " ").trim().replace(LIST_MARKER, "").replace(ENDING_MARKS, "").toLowerCase();
}

// A US letter's 11/09/2026 is November 9. The gate does not hold a date like this
// because the order could be wrong, but the person checks a named date against
// the letter. A two-digit year is this century.
const US_NUMERIC = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/;

function usNumeric(written: string): string | null {
  const m = written.trim().match(US_NUMERIC);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
  const iso = `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso) ? iso : null;
}

function isoOf(written: string, noticeIso: string | null): string | null {
  return parseWrittenDate(written) ?? usNumeric(written) ?? parseAllDates(written, noticeIso)[0] ?? null;
}

// The date the reader chose, when its own quote holds up: the sentence is in
// the letter, the date is printed in that sentence, nothing before the date
// negates it, and it is not a count from something else.
function checked(date: string, sentence: string, letterText: string, noticeIso: string | null): string | null {
  const quote = normal(sentence);
  const written = normal(date);
  if (!quote || !written || !normal(letterText).includes(quote)) return null;
  const at = quote.indexOf(written);
  if (at < 0 || NEGATED.test(quote) || COUNTED.test(quote)) return null;
  const verdict = gateSentence(sentence, noticeIso);
  return verdict.kind === "ask" && verdict.count ? null : isoOf(date, noticeIso);
}

// Whether a sentence that moves a date leaves this one standing.
function outlivesMoves(sentences: string[], isos: Set<string>, noticeIso: string | null): boolean {
  return sentences.filter((s) => MOVES_THE_DATE.test(s)).every((s) => {
    const last = parseAllDates(s, noticeIso).at(-1);
    return last !== undefined && isos.has(last);
  });
}

// What the first reply may name. Null when the reader gave no answer at all, as
// a recorded reading from before this field does, and the reply falls back to
// asking. "unsure" when it answered and the answer does not hold up, or it found
// nothing: the reply then asks and names no date.
export function nameDates(letterText: string, noticeIso: string | null, reader: ReaderDates | null): NamedDates | null {
  const sentences = splitSentences(letterText);
  const verbatim = verbatimSentences(letterText);
  if (notTheirs(letterText, sentences, verbatim)) return { kind: "not-theirs" };
  if (!reader) return null;
  if (verbatim.some((s) => REVERSES.test(s.trim()))) return { kind: "unsure" };

  const dates: NamedDate[] = [];
  const late: string[] = [];
  for (const { date, sentence, purpose } of reader.meet) {
    const iso = checked(date, sentence, letterText, noticeIso);
    if (!iso || iso === noticeIso) return { kind: "unsure" };
    const chrono = chronologyOf(iso, noticeIso);
    if (chrono === "too-far") return { kind: "unsure" };
    if (chrono === "before-notice") late.push(iso);
    else if (!dates.some((d) => d.iso === iso)) dates.push({ iso, purpose: purpose === "payment" && PROOF_OF_PAYMENT.test(sentence) ? "deadline" : purpose });
  }

  const labeled = (label: string): string[] => {
    const isos = reader.other.filter((o) => o.for === label && normal(letterText).includes(normal(o.date))).map((o) => isoOf(o.date, noticeIso));
    return [...new Set(isos.filter((iso): iso is string => iso !== null && chronologyOf(iso, noticeIso) === "ok"))];
  };

  if (dates.length > 2) return { kind: "unsure" };
  if (dates.length > 0) {
    if (!outlivesMoves(sentences, new Set(dates.map((d) => d.iso)), noticeIso)) return { kind: "unsure" };
    const interviews = labeled("interview");
    return { kind: "duty", dates, interview: interviews.length === 1 ? interviews[0]! : null };
  }
  if (late.length > 0) return { kind: "passed", iso: [...late].sort().at(-1)! };
  const appeals = labeled("appeal");
  if (appeals.length === 1 && outlivesMoves(sentences, new Set(appeals), noticeIso)) return { kind: "request", iso: appeals[0]! };
  return { kind: "unsure" };
}
