// Which date the first reply about a letter may name, as a question the
// person checks. Naming is not holding: nothing here reaches a deadline
// record, and only the gate's grammar in gate.ts holds a date. These shapes
// are wider than that grammar because the person checks the date against
// the letter first. They are still closed: a sentence that fits none names
// nothing, and the reply falls back to asking. English letters only; a
// letter in another language fits no shape.
import { DATE_PATTERN, parseAllDates, parseWrittenDate, splitSentences } from "./dates.js";
import { chronologyOf, gateSentence, obligationOf } from "./gate.js";
import type { NamedDate, NamedDates } from "./types.js";

const SPACE = / /g;
const words = (list: string[]): string => `(?:${list.map((w) => w.replace(SPACE, String.raw`\s+`)).join("|")})`;

const DATE = `(?<date>${DATE_PATTERN})`;
const BY = words(["by", "on or before", "no later than"]);
const SAME_SENTENCE = "[^.;:]*?";

// What a person is told to do to keep something. "Apply" and "call" are left
// out: an offer and a help line both use them.
const DUTY_VERB = words([
  "return", "send", "submit", "provide", "complete", "mail", "fax", "upload", "deliver", "sign", "renew",
  "recertify", "respond", "reply", "turn in", "fill out", "file", "bring", "pay", "settle", "arrange", "finish",
]);
const PARTICIPLE = words(["received", "returned", "submitted", "sent", "completed", "mailed", "postmarked", "filed", "delivered", "turned in", "uploaded"]);
const DUE_NAME = words(["deadline", "due date", "return date", "last day", "shutoff date", "shut-off date", "cutoff date"]);

// A duty stated outright, one date in the sentence.
const STATED: RegExp[] = [
  new RegExp(String.raw`(?:^|[,;:]\s+|^[-*•]\s*)(?:please\s+)?${DUTY_VERB}\b${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`\byou\s+(?:must|need\s+to|have\s+to|are\s+required\s+to)\s${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`\b(?:must|needs?\s+to|has\s+to|have\s+to)\s+(?:arrive|reach|receive|be\s+${PARTICIPLE})\b${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`^(?:your|the|this)\b${SAME_SENTENCE}\s(?:is|are)\s+due\s+(?:on\s+|by\s+)?${DATE}`, "i"),
  new RegExp(String.raw`^(?:your|the)\b${SAME_SENTENCE}\s${DUE_NAME}(?:\s+to\s+\w+)?\s+is\s+(?:on\s+)?${DATE}`, "i"),
  new RegExp(String.raw`^${DUE_NAME}\s*:\s*${DATE}`, "i"),
];

// The same duty told as what happens around it. The date after "by" is the
// one to meet, and the sentence may go on to name when a case closes.
const TOLD_AS_OUTCOME: RegExp[] = [
  new RegExp(String.raw`^if\s+(?:we|the\s+office|this\s+office|the\s+county)\s+(?:do|does|did)\s+not\s+(?:receive|get|have)\b${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`^(?:(?:a|an|the|your)\s+\w+\s+)?without\b[^.;:,]*?\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`^if\s+(?:your|the)\b[^.;:,]*?\s(?:arrives?|reach(?:es)?|(?:is|are)\s+received)\s+${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`^(?:(?:a|an|the|your)\s+)?\w+(?:\s+\w+)?\s+that\s+arrives?\s+${BY}\s+${DATE}`, "i"),
];

// Before the date, these make it the office's act, an option, or something
// already over. Stated duties only: an outcome sentence opens with its own "if".
const NOT_A_DUTY = /\b(?:not|never|cannot|may|might|can|could|will|would|was|were|had|been|optional(?:ly)?|already|later|free)\b|n['’]t\b/i;
const CONDITION_OPENING = /^(?:if|when|unless|once|should|in\s+case|for\s+(?:households?|people|anyone)|households?|people|anyone|those|only)\b/i;
// After the date, these condition it or reverse the outcome.
const CONDITION_AFTER = /\b(?:if|unless|only|except|when)\b/i;
const OUTCOME_REVERSED = /\bnot\b|n['’]t\b/i;

function matchDate(sentence: string, shapes: RegExp[]): { date: string; before: string; after: string } | null {
  for (const re of shapes) {
    const m = sentence.match(re);
    if (m?.groups?.date && m.index !== undefined) {
      const end = m.index + m[0].length;
      return { date: m.groups.date, before: sentence.slice(0, end - m.groups.date.length), after: sentence.slice(end) };
    }
  }
  return null;
}

// The date a sentence tells the person to meet, as written, or null.
export function dutyDate(sentence: string): string | null {
  const stated = matchDate(sentence, STATED);
  if (stated) {
    const named = parseAllDates(sentence).length === 1 && !NOT_A_DUTY.test(stated.before);
    return named && !CONDITION_OPENING.test(sentence) && !CONDITION_AFTER.test(stated.after) ? stated.date : null;
  }
  const outcome = matchDate(sentence, TOLD_AS_OUTCOME);
  return outcome && !OUTCOME_REVERSED.test(outcome.after) ? outcome.date : null;
}

const INTERVIEW = new RegExp(String.raw`\binterview\b${SAME_SENTENCE}\s(?:scheduled|set)\s+(?:for|on)\s+${DATE}`, "i");
const NOT_YET_OR_DONE = /\b(?:not|never|cancel+ed|moved|reschedul\w*)\b|n['’]t\b/i;
const WAS_DUE = new RegExp(String.raw`\b(?:was|were)\s+due\s+(?:on\s+)?${DATE}`, "i");
// A date on what happens next, not on what the person does.
const OUTCOME_DATE = /\b(?:effective|ends?|ending|stops?|starting|close[sd]?)\b/i;

// Wording that says a letter is someone else's, is no one's, or no longer
// stands. A subset of the gate's qualifier list, kept narrow because every
// hit costs an ordinary letter its named date.
const NOT_THEIRS = new RegExp(
  String.raw`\b(?:${[
    "addressed to (?!you\\b)",
    "copy of (?:the|a|an) (?:letter|notice) (?:sent|mailed|addressed)",
    "(?:sent|mailed|delivered|issued) to (?:your (?!address|home|mailing|last|current)|a |an |another )",
    "intended for", "meant for", "on behalf of", "another (?:person|household)", "someone else",
    "not for you", "does not concern", "this is a test", "this is an example", "specimen",
    "(?:sample|example|practice|training|template) (?:letter|notice|for)", "(?:for training|office|caseworker) use",
    "(?:file|office|courtesy|agency|county) copy", "county staff",
  ]
    .map((w) => w.replace(SPACE, String.raw`\s+`))
    .join("|")})\b|^(?:copy|duplicate|sample|sample letter|sample notice)$`,
  "i",
);
// Read only outside a condition: "if you already sent it, disregard this" is
// on ordinary letters, and the person can answer it.
const NO_LONGER_STANDS = new RegExp(
  String.raw`\b(?:${[
    "cancel+ed", "withdrawn", "rescinded", "void", "disregard", "sent in error", "by mistake", "supersedes?", "superseded",
    "replaces (?:our|the|this|your)", "(?:corrected|revised|amended) notice", "no longer (?:apply|applies|needed|required)",
    "(?:has|have) been (?:extended|postponed|rescheduled|moved)", "(?:has|have) extended", "was postponed",
    "new (?:date|deadline)", "need not", "no need to", "exempt(?:ed)?", "excused", "waived",
    "(?:do|does) not (?:need|have) to (?:return|send|respond|reply|sign|submit|renew|do)", "don['’]t (?:need|have) to (?:return|send|respond|reply|sign|submit|renew|do)",
  ]
    .map((w) => w.replace(SPACE, String.raw`\s+`))
    .join("|")})\b`,
  "i",
);
const NAMED_HEADING = /^(?:(?:[Nn]otice|[Ll]etter)\s+)?[Ff]or\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$|^[Tt]his\s+(?:letter|notice)\s+is\s+for\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$|^[Ii]nstructions\s+for\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$/;
const SALUTATION = /^\s*dear\s+[^\n]{1,60}$/gim;

function notTheirs(letterText: string, sentences: string[]): boolean {
  const salutations = new Set((letterText.match(SALUTATION) ?? []).map((s) => s.trim().toLowerCase().replace(/[\s:,]+$/, "")));
  if (salutations.size > 1) return true;
  return sentences.some((s) => NOT_THEIRS.test(s) || NAMED_HEADING.test(s) || (!CONDITION_OPENING.test(s) && NO_LONGER_STANDS.test(s)));
}

// What the first reply may name, or null when the letter gives nothing it can
// name and the reply falls back to asking. Duties come first. An appeal or a
// counted window is named only when the letter has no duty and no other date
// it cannot place, so it never stands in for a date Mano failed to read.
export function nameDates(letterText: string, noticeIso: string | null): NamedDates | null {
  const sentences = splitSentences(letterText);
  if (notTheirs(letterText, sentences)) return { kind: "not-theirs" };

  const duties = new Map<string, NamedDate>();
  const late: string[] = [];
  const appeals = new Set<string>();
  const windows: { days: number; fromIso: string; resultIso: string }[] = [];
  const interviews = new Set<string>();
  let unplaced = false;

  for (const sentence of sentences) {
    const written = dutyDate(sentence);
    const iso = written ? parseWrittenDate(written) : null;
    const dates = parseAllDates(sentence, noticeIso).filter((d) => d !== noticeIso);
    const verdict = gateSentence(sentence, noticeIso);
    const interview = sentence.match(INTERVIEW)?.groups?.date;
    const wasDue = sentence.match(WAS_DUE)?.groups?.date;
    if (iso && iso !== noticeIso) {
      const obligation = obligationOf(sentence);
      const chrono = chronologyOf(iso, noticeIso);
      if (chrono === "before-notice") late.push(iso);
      else if (chrono === "too-far") unplaced = true;
      else if (obligation === "appeal") appeals.add(iso);
      else if (!duties.has(iso)) duties.set(iso, { iso, sentence, obligation });
    } else if (verdict.kind === "ask" && verdict.count) {
      windows.push(verdict.count);
    } else if (interview && !NOT_YET_OR_DONE.test(sentence)) {
      const date = parseWrittenDate(interview);
      if (date && chronologyOf(date, noticeIso) === "ok") interviews.add(date);
    } else if (wasDue) {
      const date = parseWrittenDate(wasDue);
      if (date && chronologyOf(date, noticeIso) === "before-notice") late.push(date);
    } else if (dates.length > 0 && !OUTCOME_DATE.test(sentence)) {
      unplaced = true;
    }
  }

  if (duties.size > 2) return null;
  if (duties.size > 0) return { kind: "duty", dates: [...duties.values()], interview: interviews.size === 1 ? [...interviews][0]! : null };
  if (unplaced || interviews.size > 0) return null;
  if (appeals.size > 0) return appeals.size === 1 ? { kind: "hearing", iso: [...appeals][0]! } : null;
  if (windows.length > 0) return windows.length === 1 ? { kind: "window", ...windows[0]! } : null;
  return late.length > 0 ? { kind: "passed", iso: [...late].sort().at(-1)! } : null;
}
