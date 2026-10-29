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

const any = (words: string[]): string => `(?:${words.map((w) => w.replace(/ /g, String.raw`\s+`)).join("|")})`;

// The grammar's vocabulary. Adding a word widens what publishes, so
// each addition needs a test that it states a duty the person owes.
const DETERMINERS = any(["the", "your", "this", "these", "all", "each", "a", "both"]);
const ADJECTIVES = any([
  "signed", "completed", "written", "enclosed", "current", "required", "requested", "missing", "new",
  "renewal", "recertification", "redetermination", "application", "income", "identity", "address",
  "residency", "photo", "household", "verification", "hearing", "appeal", "tax", "medical", "yearly",
  "child care", "rent", "utility", "bank",
]);
const NOUNS = any([
  "forms?", "packets?", "paperwork", "applications?", "proofs?", "documents?", "items?", "papers",
  "verifications?", "pay stubs?", "statements?", "ids?", "cop(?:y|ies)", "information", "response",
  "reply", "appeal", "requests?", "renewal", "recertification", "letters?", "bills?", "receipts?",
  "premium", "case", "hearing", "reconsideration", "lease",
]);
const OF_PHRASE = String.raw`of\s+(?:your\s+)?(?:household\s+)?(?:income|address|identity|residency)`;
const NOUN_PHRASE = String.raw`(?:${DETERMINERS}\s+)?(?:${ADJECTIVES}\s+){0,3}${NOUNS}(?:\s+${OF_PHRASE})?(?:\s+(?:listed\s+)?(?:below|above)|\s+enclosed)?`;
const ITEM = String.raw`(?:${ADJECTIVES}\s+){0,3}${NOUNS}(?:\s+${OF_PHRASE})?`;
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
  "turned in", "uploaded", "faxed", "delivered",
]);

const VERB_PHRASE = String.raw`(?:${TRANSITIVE}\s+${OBJECT}|${INTRANSITIVE}|ask\s+for\s+${NOUN_PHRASE})(?:\s+${MODIFIER})*`;
const DUTY = String.raw`(?:(?:please\s+)?${VERB_PHRASE}|you\s+(?:must|need\s+to|have\s+to|are\s+required\s+to)\s+${VERB_PHRASE}|your\s+${ITEM}\s+must\s+(?:arrive|be\s+${PARTICIPLES})(?:\s+${MODIFIER})*|your\s+${ITEM}\s+(?:is|are)\s+due)`;

const DATE = `(?<date>${DATE_PATTERN})`;
// Calendar days only. Business-day counts ask: holidays would make a
// weekday count land on the wrong date.
const COUNT = String.raw`within\s+(?<days>\d{1,3})\s+(?:calendar\s+)?days?\s+(?:of|from|after)`;

const FORMS: { form: DeadlineForm; re: RegExp }[] = [
  { form: "by", tail: String.raw`by\s+${DATE}` },
  { form: "on-or-before", tail: String.raw`on\s+or\s+before\s+${DATE}` },
  { form: "no-later-than", tail: String.raw`no\s+later\s+than\s+${DATE}` },
  { form: "within-days-of-date", tail: String.raw`${COUNT}\s+${DATE}` },
  { form: "within-days-of-notice", tail: String.raw`${COUNT}\s+the\s+date\s+of\s+this\s+(?:notice|letter)` },
].map(({ form, tail }) => ({ form: form as DeadlineForm, re: new RegExp(`^(?<duty>${DUTY})\\s+${tail}$`, "i") }));
FORMS.push({
  form: "due",
  re: new RegExp(String.raw`^(?<duty>your\s+${ITEM}\s+(?:is|are)\s+due)\s+(?:on\s+)?${DATE}$`, "i"),
});

// Wording that reads like a deadline. A sentence that has any of it
// and does not parse into a form asks, and blocks the letter's dates.
const SPELLED_NUMBER = String.raw`(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|forty-five|fifty|sixty|seventy|eighty|ninety)`;
const ANY_COUNT = String.raw`(?:\d{1,3}|${SPELLED_NUMBER})\s+(?:business\s+|calendar\s+|working\s+)?(?:days?|weeks?|months?|hours?|years?)`;
const MONTH_WORD = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const DEADLINE_LIKE: RegExp[] = [
  /\bdue\b(?!\s+to\b)/i,
  /\b(?:deadline|postmarked)\b/i,
  /\b(?:no|not)\s+later\s+than\b/i,
  /\bon\s+or\s+before\b/i,
  new RegExp(String.raw`\b(?:within|in)\s+${ANY_COUNT}`, "i"),
  new RegExp(String.raw`\b${ANY_COUNT}\s+(?:from|after|before|following|of\s+(?:the\s+date|this\s+notice|receipt|the\s+notice))\b`, "i"),
  new RegExp(String.raw`\byou\s+have\s+${ANY_COUNT}`, "i"),
  /\b(?:today|tonight|tomorrow)\b/i,
  /\b(?:next|this|by|before|until)\s+(?:week|month|business\s+day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bend\s+of\s+(?:the\s+)?(?:day|week|month)\b/i,
  /\b(?:as\s+soon\s+as\s+possible|asap|immediately|right\s+away)\b/i,
  new RegExp(String.raw`\bby\s+(?:\d|${MONTH_WORD}\s+\d)`, "i"),
  // Dates the parser cannot read in full: two-digit years, no year.
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}\b(?!\/)/,
];

export function isDeadlineLike(sentence: string): boolean {
  return DEADLINE_LIKE.some((re) => re.test(sentence)) || findAmbiguousDate(sentence) !== null;
}

// A deadline sentence: deadline wording near a date or a count, or any
// of the wording above. A letter publishes only when its whole
// transcription holds exactly one.
const DEADLINE_WORD =
  /\b(?:by|before|no\s+later\s+than|due|within|deadline|expires?|expired|expiration|must|return(?:s|ed)?|submit(?:s|ted)?|respond(?:s|ed)?|renew(?:s|ed)?|recertify|upload(?:s|ed)?|sends?|sent|mail(?:s|ed)?)\b/i;
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
// stripped. Returns each hit with up to four words after it, so the
// person sees what was found ("if you moved"), at most three of them.
const QUALIFIER = new RegExp(
  String.raw`\b(?:${[
    "if applicable", "if", "only", "unless", "except", "when", "dear county staff", "staff",
    "office use", "caseworker use", "for county", "applies to", "does not apply", "not required",
    "cancelled", "canceled", "disregard", "void", "no longer", "ignore", "optional",
  ]
    .map((w) => w.replace(/ /g, String.raw`\s+`))
    .join("|")})\b(?:[ \t]+[A-Za-z'-]+){0,4}`,
  "gi",
);

export function qualifierPhrases(letterText: string): string[] {
  const phrases = [...letterText.matchAll(QUALIFIER)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ").trim());
  return [...new Set(phrases)].slice(0, 3);
}

// A date to know states one plain date and names no duty: no
// negation, condition or alternative.
const TO_KNOW_LEFTOVER =
  /\b(?:not|no|never|cannot|nor|none|without|if|unless|when|whenever|whether|provided|otherwise|or|either|instead|alternatively)\b|n['’]t\b/i;
const DUTY_WORDS = /\b(?:must|respond|send|submit|provide|complete|deliver|mail|bring|renew|appeal|pay)\b/i;

// The duty a deadline states, read from its own words. Dates within
// one duty are compared with each other.
export function obligationOf(text: string): Obligation {
  const t = text.toLowerCase();
  if (/\b(appeal|hearing|grievance|reconsideration|dispute|contest|decision)\b/.test(t)) return "appeal";
  if (/\b(pay|payment|premium|amount due|balance due)\b/.test(t) && !/\bpay stubs?\b/.test(t)) return "pay";
  if (/\b(renew|renewal|recertif|redetermin)\b/.test(t)) return "renew";
  if (
    /\b(respond|response|return|send|submit|provide|arrive|receive|paperwork|complete|deliver|mail|bring|due|deadline|no later than)\b/.test(
      t,
    )
  ) {
    return "respond";
  }
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
  const s = sentence.replace(/\s+/g, " ").trim().replace(/[\s.!;:,]+$/, "");
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
