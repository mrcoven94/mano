// Which date the first reply about a letter may name, as a question the
// person checks. Naming is not holding: nothing here reaches a deadline
// record, and only the gate's grammar in gate.ts holds a date. These shapes
// are wider than that grammar because the person checks the date against
// the letter first. They are still closed: a sentence that fits none names
// nothing, and the reply falls back to asking. English letters only; a
// letter in another language fits no shape.
import { DATE_PATTERN, parseAllDates, parseWrittenDate, splitSentences, verbatimSentences } from "./dates.js";
import { NAMED_HEADING, chronologyOf, gateSentence, hasQualifier, obligationOf } from "./gate.js";
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

// What a person can owe that is due on a date. A refund or a benefit is due
// to them, so "is due" names a duty only on one of these.
const OWED = words([
  "renewal", "recertification", "redetermination", "report", "forms?", "packets?", "paperwork", "applications?",
  "documents?", "proofs?", "response", "reply", "bills?", "balance", "premium", "payment", "statements?", "verification",
]);
const OWED_TO_THEM = /\b(?:refund|reimbursement|deposit|credit|benefits?|check|card)\b/i;

// A duty stated outright, one date in the sentence.
const STATED: RegExp[] = [
  new RegExp(String.raw`(?:^|,\s+|^[-*•]\s*)(?:please\s+)?${DUTY_VERB}\b${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`\byou\s+(?:must|need\s+to|have\s+to|are\s+required\s+to)\s${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`\b(?:must|needs?\s+to|has\s+to|have\s+to)\s+(?:arrive|reach|receive|be\s+${PARTICIPLE})\b${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"),
  new RegExp(String.raw`^(?:your|the|this)\b${SAME_SENTENCE}\s${OWED}\s+(?:is|are)\s+due\s+(?:on\s+|by\s+)?${DATE}`, "i"),
  new RegExp(String.raw`^(?:your|the)\b${SAME_SENTENCE}\s${DUE_NAME}(?:\s+to\s+\w+)?\s+is\s+(?:on\s+)?${DATE}`, "i"),
  new RegExp(String.raw`^${DUE_NAME}\s*:\s*${DATE}`, "i"),
];

// The same duty told as what happens around it. The date after "by" is the
// one to meet, and the sentence may go on to name when a case closes. It only
// counts when the rest says missing it costs the benefit or meeting it keeps it:
// "if it arrives by" can also mean too early.
const KEEPS = /\b(?:stays?|keeps?|continues?|remains?|nothing\s+changes|no\s+break)\b/i;
const LOSES = /\b(?:ends?|stops?|close[sd]?|den(?:y|ied)|lose|change|cut\s+off|shut\s+off|terminated?)\b/i;
const TOLD_AS_OUTCOME: { re: RegExp; says: RegExp }[] = [
  { re: new RegExp(String.raw`^if\s+(?:we|the\s+office|this\s+office|the\s+county)\s+(?:do|does|did)\s+not\s+(?:receive|get|have)\b${SAME_SENTENCE}\s${BY}\s+${DATE}`, "i"), says: LOSES },
  { re: new RegExp(String.raw`^(?:(?:a|an|the|your)\s+\w+\s+)?without\b[^.;:,]*?\s${BY}\s+${DATE}`, "i"), says: LOSES },
  { re: new RegExp(String.raw`^if\s+(?:your|the)\b[^.;:,]*?\s(?:arrives?|reach(?:es)?|(?:is|are)\s+received)\s+${BY}\s+${DATE}`, "i"), says: KEEPS },
  { re: new RegExp(String.raw`^(?:(?:a|an|the|your)\s+)?\w+(?:\s+\w+)?\s+that\s+arrives?\s+${BY}\s+${DATE}`, "i"), says: KEEPS },
];

// Before the date, these make it the office's act, an option, or something
// already over. Stated duties only: an outcome sentence opens with its own "if".
const NOT_A_DUTY = /\b(?:not|never|cannot|may|might|can|could|will|would|was|were|had|been|optional(?:ly)?|already|later|free)\b|n['’]t\b/i;
const CONDITION_OPENING = /^(?:if|when|unless|once|should|in\s+case|for\s+(?:households?|people|anyone)|households?|people|anyone|those|only)\b/i;
// After the date, these condition it or reverse the outcome.
const CONDITION_AFTER = /\b(?:if|unless|only|except|when|depending)\b/i;
const OUTCOME_REVERSED = /\bnot\b|n['’]t\b|\b(?:reject\w*|early)\b/i;
// A second date the parser will not read still makes it two dates.
const NUMERIC_DATE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/;

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
    const named = parseAllDates(sentence).length === 1 && !NUMERIC_DATE.test(stated.after) && !NOT_A_DUTY.test(stated.before) && !OWED_TO_THEM.test(stated.before);
    return named && !CONDITION_OPENING.test(sentence) && !CONDITION_AFTER.test(stated.after) ? stated.date : null;
  }
  for (const { re, says } of TOLD_AS_OUTCOME) {
    const outcome = matchDate(sentence, [re]);
    if (outcome) return says.test(outcome.after) && !OUTCOME_REVERSED.test(outcome.after) ? outcome.date : null;
  }
  return null;
}

// A hearing the person asks for. "Your hearing must be completed" is the office's.
const ASKS_FOR_REVIEW = /\b(?:requests?|ask\s+for|file\s+(?:an?\s+|your\s+)?appeal)\b/i;
// "Is due" with a date that is not a duty: a refund owed to them, a review.
const IS_DUE = /\b(?:is|are)\s+due\b/i;
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
    "not for you", "does not concern", "(?:does|do) not apply", "this is a test", "this is an example", "specimen",
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
const THIS_IS_FOR = /^[Tt]his\s+(?:letter|notice)\s+is\s+for\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$|^[Ii]nstructions\s+for\s+[A-Z][\w'-]+\s+[A-Z][\w'-]+$/;
// A heading the gate reads as a name can be the letter's subject instead.
const LETTER_SUBJECT = /\b(?:renewal|recertification|notice|review|benefits?|account|case|deadline|interview|coverage|change|denial|approval|due)\b/i;
const SALUTATION = /^\s*dear\s+[^\n]{1,60}$/gim;

function appearsTwice(text: string, name: string): boolean {
  return text.split(name).length > 2;
}

function notTheirs(letterText: string, sentences: string[], verbatim: string[]): boolean {
  const salutations = new Set((letterText.match(SALUTATION) ?? []).map((s) => s.trim().toLowerCase().replace(/[\s:,]+$/, "")));
  if (salutations.size > 1) return true;
  const otherPerson = (raw: string): boolean => {
    if (!NAMED_HEADING.test(raw)) return false;
    const name = raw.replace(/^(?:(?:notice|letter)\s+)?(?:for|re:)\s*/i, "").replace(/\.$/, "");
    return !LETTER_SUBJECT.test(name) && !appearsTwice(letterText, name);
  };
  return verbatim.some(otherPerson) || sentences.some((s) => NOT_THEIRS.test(s) || THIS_IS_FOR.test(s) || (!CONDITION_OPENING.test(s) && NO_LONGER_STANDS.test(s)));
}

// Sentences the gate stops a letter on that ordinary letters carry and that
// cannot change a date: help offers, sign-offs, what a missed date costs. The
// list is closed. Any other sentence the gate stops on names no date.
const HELP_OFFER = /^if\b[^;]*,\s+(?:call|contact|tell)\b/i;
const LIFTS_A_DUTY = /\b(?:not|never|need\s+not|ignore|disregard|instead|stop)\b|n['’]t\b/i;
const ORDINARY: RegExp[] = [
  /^thank\s+you$/i,
  /\bappeal\b.*\bwithin\b.*\bnotice\s+date$/i,
  /^otherwise\s+your\b.*\b(?:ends?|stops?|may\s+change)\b/i,
  /^late\s+\w+\s+may\s+change\s+your\s+benefits\b/i,
  /^if\s+service\s+is\s+shut\s+off\b.*\bfee\b/i,
  /^this\s+notice\s+covers\s+your\b/i,
  /^do\s+not\s+send\s+originals$/i,
  /^do\s+not\s+wait\s+for\s+the\s+mail$/i,
  /^our\s+office\s+is\s+closed\b/i,
  /^you\s+can\s+request\s+(?:a|an)\b.*\bextension\b/i,
  // Warnings about money and secrets, on real letters and on scams alike. A
  // scam is screened on its own, before any of this.
  /^(?:you\s+(?:will\s+)?)?never\s+(?:have\s+to\s+pay|send\s+your\s+(?:pin|password)|give\s+your\s+(?:pin|password))\b/i,
  /^if\s+someone\s+asks\b.*\bscam$/i,
  /\brent\s+to\s+your\s+landlord$/i,
];
// What it costs to miss the date, when the date itself is said elsewhere.
const MISSED_COSTS = /^if\b[^,;]*\b(?:late|miss\w*|do\s+not\s+receive|not\s+received)\b[^,;]*,\s*(.+)$/i;
const ORDINARY_HEADING = /^(?:send\s+these\b.*|what\s+we\s+need\s+from\s+you|what\s+to\s+send):$/i;
const ADDRESSEE_LINE = /^(?:to|attn|attention)\s*:\s*(.+)$/i;
// "Sample" and "example" stop a hold anywhere, and that stays. On a street
// name or a sample form they do not make this letter a sample.
const INCIDENTAL = /\b\d+\s+(?:Sample|Example)\s+(?:St|Street|Ave|Avenue|Rd|Road|Way|Blvd|Ln|Lane|Dr|Drive)\b|\bsample\s+(?:forms?|packets?|pages?)\b/gi;

function stopsNaming(raw: string, letterText: string): boolean {
  const masked = raw.replace(INCIDENTAL, "").trim();
  if (!hasQualifier(masked)) return false;
  const line = masked.replace(/[.!;,]+$/, "");
  if (ORDINARY_HEADING.test(line) || ORDINARY.some((re) => re.test(line))) return false;
  if (HELP_OFFER.test(line) && !LIFTS_A_DUTY.test(line)) return false;
  const cost = line.match(MISSED_COSTS)?.[1];
  if (cost && LOSES.test(cost) && !OUTCOME_REVERSED.test(cost) && !/\b(?:ignore|disregard|instead|extend\w*|continue\w*)\b/i.test(cost)) return false;
  const addressee = line.match(ADDRESSEE_LINE)?.[1];
  if (addressee && appearsTwice(letterText, addressee)) return false;
  if (NAMED_HEADING.test(line)) return false;
  return dutyDate(line) === null;
}

// What the first reply may name, or null when the letter gives nothing it can
// name and the reply falls back to asking. A letter the gate stops on for
// anything outside the closed list above names nothing. Duties come first. An
// appeal or a counted window is named only when the letter has no duty and no
// other date it cannot place, so it never stands in for a date Mano failed to
// read.
export function nameDates(letterText: string, noticeIso: string | null): NamedDates | null {
  const sentences = splitSentences(letterText);
  const verbatim = verbatimSentences(letterText);
  if (notTheirs(letterText, sentences, verbatim)) return { kind: "not-theirs" };
  if (verbatim.some((s) => stopsNaming(s, letterText))) return { kind: "unsure" };

  const duties = new Map<string, NamedDate>();
  const late: string[] = [];
  const appeals = new Set<string>();
  const windows: { days: number; fromIso: string; resultIso: string }[] = [];
  const interviews = new Set<string>();
  let unplaced = false;
  let notOwed = false;

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
      else if (obligation === "appeal" && !ASKS_FOR_REVIEW.test(sentence)) notOwed = true;
      else if (obligation === "appeal") appeals.add(iso);
      else if (!duties.has(iso)) duties.set(iso, { iso, sentence, obligation });
    } else if (IS_DUE.test(sentence) && dates.length > 0) {
      notOwed = true;
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

  if (notOwed) return { kind: "unsure" };
  if (duties.size > 2) return null;
  if (duties.size > 0) return { kind: "duty", dates: [...duties.values()], interview: interviews.size === 1 ? [...interviews][0]! : null };
  if (unplaced || interviews.size > 0) return null;
  if (appeals.size > 0) return appeals.size === 1 ? { kind: "hearing", iso: [...appeals][0]! } : null;
  if (windows.length > 0) return windows.length === 1 ? { kind: "window", ...windows[0]! } : null;
  return late.length > 0 ? { kind: "passed", iso: [...late].sort().at(-1)! } : null;
}
