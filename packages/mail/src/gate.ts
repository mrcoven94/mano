// The deadline publish gate. A sentence publishes only when the whole
// sentence parses under the grammar below: the person as subject (an
// imperative, "you must ...", or "your <item> must ..."/"is due"), an
// allowlisted duty verb, an allowlisted object, only allowlisted
// modifiers, then one date form, then the end. Anything the grammar
// does not cover asks. Asking is always safe; a wrong deadline is not.
// A sentence with no deadline-like wording and one plain date becomes
// a date to know.

import { DATE_PATTERN, findAmbiguousDate, parseAllDates, parseWrittenDate } from "./dates.js";
import type { Obligation } from "./types.js";

export type DeadlineForm =
  | "by"
  | "on-or-before"
  | "no-later-than"
  | "within-days-of-date"
  | "within-days-of-notice"
  | "due";

// A counted deadline never publishes. The question shows the count,
// the date it was counted from, and the result.
export interface DayCount {
  days: number;
  fromIso: string;
  resultIso: string;
}

export type AskReason =
  | "unrecognized"
  | "ambiguous-date"
  | "notice-date"
  | "before-notice"
  | "too-far"
  | "no-notice-date"
  | "counted";

export type GateVerdict =
  | { kind: "deadline"; iso: string; form: DeadlineForm; obligation: Obligation }
  | { kind: "date-to-know"; iso: string }
  | { kind: "ask"; reason: AskReason; count?: DayCount }
  | { kind: "no-date" };

const SPACE = / /g;
const any = (words: string[]): string => `(?:${words.map((w) => w.replace(SPACE, String.raw`\s+`)).join("|")})`;

// The grammar's vocabulary. Adding a word widens what publishes, so
// each addition needs a test that it states a duty the person owes.
const DETERMINERS = any(["the", "your", "this", "these", "all", "each", "a", "both"]);
const ADJECTIVES = any([
  "signed", "completed", "written", "enclosed", "current", "required", "requested", "missing", "new",
  "renewal", "recertification", "redetermination", "application", "income", "identity", "address",
  "residency", "photo", "household", "verification", "tax", "medical", "yearly",
  "child care", "rent", "utility", "bank", "next",
]);
// What the person sends, asks for or pays. "Hearing" and "appeal"
// qualify only a request: a hearing form may be the request itself or
// a paper for one, so it asks.
const OWED_NOUNS = [
  "forms?", "packets?", "paperwork", "applications?", "proofs?", "documents?", "items?", "papers",
  "verifications?", "pay stubs?", "statements?", "ids?", "cop(?:y|ies)", "information", "response",
  "reply", "appeal", "requests?", "renewal", "recertification", "letters?", "bills?", "receipts?",
  "premium", "lease", "(?:hearing|appeal) requests?", "requests? for(?: a)? (?:hearing|reconsideration)",
];
// What the office holds, decides or reviews. The person can request
// one, so it may be an object, but never the subject of a duty: "your
// hearing must be completed by" is the office's date, not the person's.
const OFFICE_NOUNS = ["case", "hearing", "reconsideration"];
// A program a duty belongs to, as in "your SNAP renewal". It only
// comes before a paper or a duty the person owes, never a hearing or a
// case, which the office holds or reviews. A program alone names what
// the person gets, not what they owe. Basic Food and CalFresh are the
// names Washington and California print on SNAP letters.
const PROGRAMS = any([
  "SNAP", "food benefits", "Basic Food", "CalFresh", "WIC", "Medicaid", "CHIP", "health coverage", "TANF",
  "cash assistance",
]);
const PROGRAM_NOUNS = any(["forms?", "packets?", "paperwork", "applications?", "renewal", "recertification"]);
// Which of the person's own papers, as in "your most recent pay stub".
// A paper they already have is never a renewal, so a renewal word
// anywhere after it asks.
const RECENT = String.raw`${any(["most recent", "two most recent", "latest", "last"])}\s+(?!.*\b(?:renew|recertif|redetermin))`;
const OF_PHRASE = String.raw`of\s+(?:your\s+)?(?:household\s+)?(?:income|address|identity|residency)`;
const item = (nouns: string[]): string =>
  String.raw`(?:${PROGRAMS}\s+(?:${ADJECTIVES}\s+){0,3}${PROGRAM_NOUNS}|(?:${RECENT})?(?:${ADJECTIVES}\s+){0,3}${any(nouns)}(?:\s+${OF_PHRASE})?)`;
const ITEM = item([...OWED_NOUNS, ...OFFICE_NOUNS]);
const OWED_ITEM = item(OWED_NOUNS);
const NOUN_PHRASE = String.raw`(?:${DETERMINERS}\s+)?${ITEM}(?:\s+(?:listed\s+)?(?:below|above)|\s+enclosed)?`;
const MONEY = String.raw`\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?`;
const OBJECT = String.raw`(?:${NOUN_PHRASE}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)${NOUN_PHRASE})*|it|them|${MONEY})`;

const TRANSITIVE = any([
  "return", "send", "submit", "provide", "complete", "bring", "mail", "fax", "upload", "deliver",
  "sign", "turn in", "fill out", "file", "renew", "request", "pay", "show", "give",
]);
const INTRANSITIVE = any(["respond", "reply", "apply", "renew", "recertify", "appeal", "pay"]);
const MODIFIER = any([
  "to us", "to the office", "to our office", "to this office", "to the county office",
  "by mail", "by fax", "online", "in person", "in writing", "so it arrives", "so they arrive",
]);
const PARTICIPLES = any([
  "returned", "submitted", "sent", "completed", "mailed", "postmarked", "signed", "filed",
  "turned in", "uploaded", "faxed", "delivered", "received",
]);

const VERB_PHRASE = String.raw`(?:${TRANSITIVE}\s+${OBJECT}|${INTRANSITIVE}|ask\s+for\s+${NOUN_PHRASE})(?:\s+${MODIFIER})*`;
const DUTY = String.raw`(?:(?:please\s+)?${VERB_PHRASE}|you\s+(?:must|need\s+to|have\s+to|are\s+required\s+to)\s+${VERB_PHRASE}|your\s+${OWED_ITEM}\s+must\s+(?:arrive|be\s+${PARTICIPLES})(?:\s+${MODIFIER})*|your\s+${OWED_ITEM}\s+(?:is|are)\s+due)`;

const DATE = `(?<date>${DATE_PATTERN})`;
// Calendar days only. Business-day counts ask: holidays would make a
// weekday count land on the wrong date.
const COUNT = String.raw`within\s+(?<days>\d{1,3})\s+(?:calendar\s+)?days?\s+(?:of|from|after)`;

const FROM_NOTICE = String.raw`${COUNT}\s+the\s+(?:date\s+of\s+this\s+(?:notice|letter)|notice\s+date(?:\s+printed\s+above)?)`;

const FORMS: { form: DeadlineForm; re: RegExp }[] = [
  { form: "by", tail: String.raw`by\s+${DATE}` },
  { form: "on-or-before", tail: String.raw`on\s+or\s+before\s+${DATE}` },
  { form: "no-later-than", tail: String.raw`no\s+later\s+than\s+${DATE}` },
  { form: "within-days-of-date", tail: String.raw`${COUNT}\s+${DATE}` },
  { form: "within-days-of-notice", tail: FROM_NOTICE },
].map(({ form, tail }) => ({ form: form as DeadlineForm, re: new RegExp(`^(?<duty>${DUTY})\\s+${tail}$`, "i") }));
// Reaching the office is read only for a count, which never publishes.
FORMS.push({
  form: "within-days-of-notice",
  re: new RegExp(String.raw`^(?<duty>your\s+${OWED_ITEM}\s+must\s+reach\s+the\s+review\s+office)\s+${FROM_NOTICE}$`, "i"),
});
FORMS.push({
  form: "due",
  re: new RegExp(String.raw`^(?<duty>your\s+${OWED_ITEM}\s+(?:is|are)\s+due)\s+(?:on\s+)?${DATE}$`, "i"),
});

// Wording that reads like a deadline. A sentence that has any of it
// and does not parse into a form asks, and blocks the letter's dates.
const SPELLED_NUMBER = String.raw`(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|forty-five|fifty|sixty|seventy|eighty|ninety)`;
const ANY_COUNT = String.raw`(?:\d{1,3}|${SPELLED_NUMBER})\s+(?:business\s+|calendar\s+|working\s+)?(?:days?|weeks?|months?|hours?|years?)`;
const MONTH_WORD = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const DEADLINE_LIKE: RegExp[] = [
  /\bdue\b(?!\s+to\b)/i,
  /\b(?:deadline|postmarked|overdue)\b/i,
  /\b(?:no|not)\s+later\s+than\b/i,
  /\bon\s+or\s+before\b/i,
  new RegExp(String.raw`\b(?:within|in)\s+${ANY_COUNT}`, "i"),
  new RegExp(String.raw`\b${ANY_COUNT}\s+(?:from|after|before|following|of\s+(?:the\s+date|this\s+notice|receipt|the\s+notice))\b`, "i"),
  new RegExp(String.raw`\byou\s+have\s+${ANY_COUNT}`, "i"),
  /\b(?:today|tonight|tomorrow)\b/i,
  /\b(?:next|this|by|before|until)\s+(?:week|month|business\s+day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:on|close[sd]?|ends?|stops?|expires?)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:on|by|before|until)\s+the\s+\d{1,2}(?:st|nd|rd|th)\b/i,
  /\bend\s+of\s+(?:the\s+)?(?:day|week|month)\b/i,
  /\b(?:as\s+soon\s+as\s+possible|asap|immediately|right\s+away)\b/i,
  new RegExp(String.raw`\bby\s+(?:\d|${MONTH_WORD}\s+\d)`, "i"),
  // Dates the parser cannot read in full: two-digit years, no year.
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}\b(?!\/)/,
];

const WHITESPACE_RUN = /\s+/g;
const TRAILING_PUNCTUATION = /[\s.!;:,]+$/;

function tidy(sentence: string): string {
  return sentence.replace(WHITESPACE_RUN, " ").trim().replace(TRAILING_PUNCTUATION, "");
}

export function isDeadlineLike(sentence: string): boolean {
  return DEADLINE_LIKE.some((re) => re.test(sentence)) || findAmbiguousDate(sentence) !== null;
}

// An approval letter's "next renewal" is the renewal the person owes,
// so it is deadline wording, never a date to know.
const NEXT_RENEWAL = String.raw`next\s+(?:renewal|recertification|redetermination)`;

// A deadline sentence: deadline wording near a date or a count, or any
// of the wording above. A letter publishes only when its whole
// transcription holds exactly one.
const DEADLINE_WORD = new RegExp(
  String.raw`\b(?:by|before|until|no\s+later\s+than|due|within|deadline|last\s+day|close[sd]?|closing|expires?|expired|expiration|must|return(?:s|ed)?|submit(?:s|ted)?|respond(?:s|ed)?|renew(?:s|ed)?|recertify|upload(?:s|ed)?|sends?|sent|mail(?:s|ed)?|${NEXT_RENEWAL})\b`,
  "i",
);
const DATE_OR_COUNT = new RegExp(
  String.raw`\b(?:${ANY_COUNT}|today|tonight|tomorrow|next\s+(?:week|month))\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b${MONTH_WORD}\s+\d{1,2}\b`,
  "i",
);

export function isDeadlineSentence(sentence: string): boolean {
  if (isDeadlineLike(sentence)) return true;
  return DEADLINE_WORD.test(sentence) && (DATE_OR_COUNT.test(sentence) || parseAllDates(sentence).length > 0);
}

// Conditions, audiences and cancellations that make a deadline
// someone else's, not yet owed, or withdrawn. Searched across the whole
// letter, salutation and headings included, before anything is
// stripped, one sentence at a time. The gate reads each sentence alone,
// so it cannot tell what "the date above" points at or whether a program
// named here matches the duty; those stop the letter too. This list
// can only catch wording it names: other wording for an exception does
// not stop a letter.
const QUALIFIER = new RegExp(
  String.raw`\b(?:${[
    "if applicable", "if", "only", "unless", "except", "when", "dear county staff", "staff",
    "office use", "caseworker use", "for county", "applies to", "does not apply", "not required",
    "cancelled", "canceled", "disregard", "void", "no longer", "ignore", "optional",
    "withdrawn", "rescinded", "no action", "not needed", "provided that", "providers",
    // A date the sentence points at instead of naming, or a change of date.
    "(?:the|that|this|said|same|stated|your|each|any|another) (?:[a-z-]+ ){0,2}date", "date (?:above|below)",
    "(?:new|later|earlier|different|other|revised|corrected|updated) (?:[a-z]+ )?(?:date|deadline)",
    // What the letter says it is about.
    "this (?:notice|letter|mailing|form|packet) (?:concerns|covers|is about|is for|relates to)",
    // Someone else's letter, or no one's.
    "addressed to", "(?<!\\.)example", "sample", "specimen", "template", "draft",
    "copy of (?:the|a|an|this) (?:letter|notice)", "(?:sent|mailed|delivered|issued) to (?:your|a|an|another)",
    "instructions for", "on behalf of", "intended for", "addressee", "recipient", "another (?:person|household)",
    "someone else", "neighbors?", "landlord", "roommate", "spouse", "^copy", "(?:file|office|courtesy|agency|county) copy",
    "duplicate", "not for you", "does not concern", "this is a test", "practice", "training",
    // The duty lifted, moved or replaced.
    "otherwise", "need not", "(?:not|(?:do|does|did)n['\u2019]t) (?:need|have) to", "no need", "not necessary", "unnecessary", "however",
    "instead", "alternatively", "exempt(?:ed)?", "excused", "waived?", "skip", "wait", "(?<!no )(?<!not )later",
    "extend\\w*", "extension", "postpone\\w*", "moved", "reschedul\\w*", "replace\\w*", "supersede\\w*",
    "in error", "mistake", "corrected", "revised", "amended", "already", "nothing", "no response", "no reply",
    "no further", "previous", "old notice", "last year's", "expired", "tentative", "estimate[sd]?",
    "(?:may|can|subject to) change", "under review", "(?:is|are) complete", "received your", "(?:we|office) ha(?:ve|s) your",
    "thank you", "all set", "(?:is|are) closed", "(?:has|have) ended", "without this form", "for you", "separately",
    "dependents", "some (?:families|households|people|dates)", "stop(?: here)?$", "hold this", "until we", "not late",
    "(?:households?|people|persons|anyone|those|applicants|members|residents) (?:that|who|with|without)",
    "(?:not|never|(?:do|does|did|wo|ca|would|should)n['\u2019]t)\\b[^.]{0,40}\\b(?:return|send|submit|respond|reply|renew|recertify|sign|apply|(?:file|mail) (?:it|them|the|this|your))",
  ]
    .map((w) => w.replace(SPACE, String.raw`\s+`))
    .join("|")})\b|\b(?:to|attn|attention|cc)\s*:`,
  "i",
);

// Whole sentences that carry one of those words and still leave the
// letter's deadline alone: a help offer, or a word about copies, proof
// or corrections. Each is closed, so any other condition, date or
// outcome still stops the letter, and adding one needs a test that it
// cannot change whether, when or for whom the deadline is owed.
const CONTACT = String.raw`(?:contact|call)\s+(?:us|this\s+office|our\s+office|the\s+(?:(?:renewal|redetermination|recertification|scheduling|verification|hearing|benefits|county|review)\s+)?(?:desk|office|unit)|\(\d{3}\)\s*\d{3}-\d{4})`;
const HELP_NEEDED = String.raw`you\s+(?:have\s+(?:any\s+)?questions|need\s+(?:help|assistance|another\s+copy|a\s+copy)(?:\s+(?:reading|completing|with)\s+(?:the|this|your)\s+(?:packet|form|notice|letter))?)`;
const HARMLESS = new RegExp(
  `^(?:${[
    String.raw`if\s+${HELP_NEEDED},\s+${CONTACT}(?:\s+and\s+provide\s+your\s+case\s+number)?`,
    String.raw`${CONTACT}\s+if\s+${HELP_NEEDED}`,
    String.raw`if\s+the\s+item\s+is\s+unavailable,\s+${CONTACT}\s+before\s+the\s+return\s+date\s+to\s+discuss\s+other\s+proof`,
    String.raw`send\s+copies\s+unless\s+an\s+original\s+is\s+(?:specifically\s+)?requested`,
    String.raw`review\s+(?:each\s+entry|every\s+page|the\s+form|the\s+information)\s+and\s+(?:correct|change|update)\s+any\s+information\s+that\s+is\s+no\s+longer\s+(?:accurate|correct|current)`,
    String.raw`sign\s+the\s+(?:certification|form)(?:\s+on\s+the\s+last\s+page)?,?\s+even\s+if\s+there\s+are\s+no\s+changes`,
  ].join("|")})$`,
  "i",
);

// A heading that names a person, who may not be the one reading.
const NAMED_HEADING = /^(?:(?:(?:[Nn]otice|[Ll]etter)\s+)?[Ff]or\s+|[Rr][Ee]:\s*)[A-Z][\w'-]+\s+[A-Z][\w'-]+\.?$/;
// A sentence ending in a colon is a heading for what follows, and the
// gate cannot read what follows under it. Only a salutation may end so.
const SALUTATION = /^dear(?:\s+[a-z][a-z.'-]*){1,5}\s*:$/i;

export function hasQualifier(sentence: string): boolean {
  const raw = sentence.trim();
  if (raw.endsWith(":") && !SALUTATION.test(raw)) return true;
  const exempt = !/[;,!]$/.test(raw) && HARMLESS.test(tidy(raw));
  return !exempt && (QUALIFIER.test(tidy(raw)) || NAMED_HEADING.test(raw));
}

// A date to know states one plain date and names no duty: no
// negation, condition or alternative.
const TO_KNOW_LEFTOVER =
  /\b(?:not|no|never|cannot|nor|none|without|if|unless|when|whenever|whether|provided|otherwise|or|either|instead|alternatively)\b|n['’]t\b/i;
// Duty or deadline wording keeps a sentence out of dates to know; it
// becomes a deadline candidate instead.
const DUTY_WORDS = new RegExp(
  String.raw`\b(?:must|respond|send|submit|provide|complete|deliver|mail|bring|renew|appeal|pay|last\s+day|close[sd]?|closing|expire[sd]?|expiration|due|deadline|by|before|until|no\s+later\s+than|${NEXT_RENEWAL})\b`,
  "i",
);

// A participle the grammar publishes ("must be received") states the
// same response as its verb.
const RESPOND = new RegExp(
  String.raw`\b(?:respond|response|return|send|submit|provide|arrive|receive|paperwork|complete|deliver|mail|bring|due|deadline|no\s+later\s+than|${PARTICIPLES})\b`,
);

// The duty a deadline states, read from its own words. Dates within
// one duty are compared with each other.
const APPEAL_WORDS = /\b(appeal|hearing|grievance|reconsideration|dispute|contest|decision)\b/;
const PAY_WORDS = /\b(pay|payment|premium|amount due|balance due)\b/;
const PAY_STUBS = /\bpay stubs?\b/;
const RENEW_WORDS = /\b(renew\w*|recertif\w*|redetermin\w*)\b/;

export function obligationOf(text: string): Obligation {
  const t = text.toLowerCase();
  if (APPEAL_WORDS.test(t)) return "appeal";
  if (PAY_WORDS.test(t) && !PAY_STUBS.test(t)) return "pay";
  if (RENEW_WORDS.test(t)) return "renew";
  if (RESPOND.test(t)) return "respond";
  return "other";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function addDays(anchorIso: string, days: number): string {
  const [y, m, d] = anchorIso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// A deadline before the notice date, or more than a year after it,
// asks. Without a notice date there is nothing to check against.
export function chronologyOf(deadlineIso: string, noticeIso: string | null): "ok" | "before-notice" | "too-far" {
  if (!noticeIso) return "ok";
  if (deadlineIso < noticeIso) return "before-notice";
  const [y, m, d] = noticeIso.split("-").map(Number);
  const limit = new Date(Date.UTC(y! + 1, m! - 1, d));
  const limitIso = `${limit.getUTCFullYear()}-${pad(limit.getUTCMonth() + 1)}-${pad(limit.getUTCDate())}`;
  if (deadlineIso > limitIso) return "too-far";
  return "ok";
}

function matchForm(s: string): { form: DeadlineForm; groups: Record<string, string | undefined> } | null {
  for (const { form, re } of FORMS) {
    const m = s.match(re);
    if (m?.groups) return { form, groups: m.groups };
  }
  return null;
}


// Gates one sentence as splitSentences returns it.
export function gateSentence(sentence: string, noticeIso: string | null): GateVerdict {
  const s = tidy(sentence);
  if (findAmbiguousDate(s)) return { kind: "ask", reason: "ambiguous-date" };
  const match = matchForm(s);
  if (match) {
    const { form, groups } = match;
    if (form === "within-days-of-date" || form === "within-days-of-notice") {
      // The notice date is only as good as the reader's label for it.
      const fromIso = form === "within-days-of-notice" ? noticeIso : parseWrittenDate(groups.date ?? "");
      if (!fromIso) return { kind: "ask", reason: "no-notice-date" };
      const days = Number(groups.days);
      return { kind: "ask", reason: "counted", count: { days, fromIso, resultIso: addDays(fromIso, days) } };
    }
    const iso = parseWrittenDate(groups.date ?? "");
    if (!iso) return { kind: "ask", reason: "unrecognized" };
    if (noticeIso && iso === noticeIso) return { kind: "ask", reason: "notice-date" };
    const chrono = chronologyOf(iso, noticeIso);
    if (chrono !== "ok") return { kind: "ask", reason: chrono };
    return { kind: "deadline", iso, form, obligation: obligationOf(groups.duty ?? s) };
  }
  if (isDeadlineLike(s)) return { kind: "ask", reason: "unrecognized" };
  const dates = parseAllDates(s);
  if (dates.length === 0) return { kind: "no-date" };
  if (dates.length > 1 || TO_KNOW_LEFTOVER.test(s) || DUTY_WORDS.test(s)) return { kind: "ask", reason: "unrecognized" };
  if (noticeIso && dates[0] === noticeIso) return { kind: "ask", reason: "notice-date" };
  return { kind: "date-to-know", iso: dates[0]! };
}
