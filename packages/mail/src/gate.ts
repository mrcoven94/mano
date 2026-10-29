// The deadline publish gate. A sentence the reader returned as a
// deadline publishes only when the whole sentence, after trimming the
// salutation and trailing punctuation, is one of the forms in FORMS
// with exactly one date and nothing left over. Everything else, such
// as negation, alternatives, conditions, hedges, a second date or a
// second count, asks the person instead. Asking is always safe; a
// wrong deadline is not. Sentences that name no duty and state one
// plain date become dates to know.

import { DATE_PATTERN, findAmbiguousDate, parseAllDates, parseWrittenDate } from "./dates.js";
import type { Obligation } from "./types.js";

export type DeadlineForm =
  | "by"
  | "on-or-before"
  | "no-later-than"
  | "within-days-of-date"
  | "within-days-of-notice"
  | "due";

export interface DayCount {
  days: number;
  anchorIso: string;
  // The anchor as the letter writes it, or null when it is the
  // letter's own notice date.
  anchorText: string | null;
}

export type AskReason =
  | "unrecognized"
  | "ambiguous-date"
  | "notice-date"
  | "before-notice"
  | "too-far"
  | "no-notice-date";

export type GateVerdict =
  | { kind: "deadline"; iso: string; form: DeadlineForm; obligation: Obligation; count: DayCount | null }
  | { kind: "date-to-know"; iso: string }
  | { kind: "ask"; reason: AskReason }
  | { kind: "no-date" };

const DATE = `(?<date>${DATE_PATTERN})`;
// Calendar days only. Business-day counts ask: holidays would make a
// weekday count land on the wrong date.
const COUNT = String.raw`within\s+(?<days>\d{1,3})\s+(?:calendar\s+)?days?\s+(?:of|from|after)`;

// The closed set. The duty half of each form must pass isDutyClause.
const FORMS: { form: DeadlineForm; re: RegExp }[] = [
  { form: "on-or-before", re: new RegExp(String.raw`^(?<duty>.+?)\s+on\s+or\s+before\s+${DATE}$`, "i") },
  { form: "no-later-than", re: new RegExp(String.raw`^(?<duty>.+?)\s+no\s+later\s+than\s+${DATE}$`, "i") },
  { form: "within-days-of-date", re: new RegExp(String.raw`^(?<duty>.+?)\s+${COUNT}\s+${DATE}$`, "i") },
  {
    form: "within-days-of-notice",
    re: new RegExp(String.raw`^(?<duty>.+?)\s+${COUNT}\s+the\s+date\s+of\s+this\s+(?:notice|letter)$`, "i"),
  },
  { form: "by", re: new RegExp(String.raw`^(?<duty>.+?)\s+by\s+${DATE}$`, "i") },
];

// "Renewal due November 20, 2026", "Your payment is due on December 1, 2026".
const NOUN_PHRASE = String.raw`(?!(?:we|i|our|us)\b)(?:(?:your|the|this|these|each)\s+)?[a-z]+(?:\s+[a-z]+){0,3}`;
const DUE_FORM = new RegExp(String.raw`^(?<duty>${NOUN_PHRASE})\s+(?:(?:is|are)\s+)?due\s+(?:on\s+)?${DATE}$`, "i");

const VERBS = [
  "respond", "reply", "return", "send", "submit", "provide", "complete", "renew", "recertify",
  "pay", "appeal", "request", "file", "mail", "bring", "sign", "call", "contact", "schedule",
  "turn in", "upload", "fax", "fill out", "apply", "ask", "give", "show", "deliver", "report", "make",
];
const PARTICIPLES = [
  "returned", "submitted", "sent", "completed", "mailed", "postmarked", "signed", "filed",
  "paid", "made", "turned in", "uploaded", "faxed", "delivered",
];
const words = (list: string[]): string => `(?:${list.map((w) => w.replace(/ /g, String.raw`\s+`)).join("|")})`;

// Who owes what. The person is the subject: an imperative, "you
// must", or the person's own item that must arrive or is due. "We
// must receive" is the agency's side and is not here.
const DUTY_SHAPES: RegExp[] = [
  new RegExp(String.raw`^(?:please\s+)?${words(VERBS)}\b`, "i"),
  new RegExp(String.raw`^you\s+(?:must|need\s+to|have\s+to|are\s+required\s+to)\s+${words(VERBS)}\b`, "i"),
  new RegExp(String.raw`^${NOUN_PHRASE}\s+must\s+(?:arrive|be\s+${words(PARTICIPLES)})$`, "i"),
  new RegExp(String.raw`^${NOUN_PHRASE}\s+(?:is|are)\s+due$`, "i"),
];

// Words that make the duty half anything but a plain duty: negation,
// past tense, conditions, alternatives, hedges, relative timing, and
// time units that would be a second count.
const LEFTOVER =
  /\b(?:not|no|never|cannot|nor|none|nothing|without|was|were|been|had|if|unless|when|whenever|until|once|provided|except|whether|after|before|otherwise|while|or|either|instead|alternatively|may|might|could|would|can|should|will|shall|possibly|probably|approximately|around|earlier|later|sooner|prior|earliest|latest|early|late|days?|weeks?|months?|years?|hours?)\b|n['’]t\b|\bas\s+long\s+as\b/i;

function isDutyClause(duty: string, dueForm: boolean): boolean {
  if (LEFTOVER.test(duty)) return false;
  if (parseAllDates(duty).length > 0) return false;
  return dueForm || DUTY_SHAPES.some((re) => re.test(duty));
}

// A sentence that names no duty may still be a date to know, but only
// when it states one plain date: no negation, condition or alternative.
const TO_KNOW_LEFTOVER =
  /\b(?:not|no|never|cannot|nor|none|without|if|unless|when|whenever|whether|provided|otherwise|or|either|instead|alternatively)\b|n['’]t\b/i;
const ANY_COUNT = /\b\d{1,3}\s+(?:business\s+|calendar\s+)?(?:days?|weeks?|months?|years?|hours?)\b/i;

// Duty verbs for routing a sentence outside the forms: one naming a
// duty asks; one naming none can be a date to know. Only verbs that
// never read as nouns, so "tax return" and "we received your
// response" state no duty, and neither do receive and arrive.
const DUTY_WORDS =
  /\b(?:must|due(?!\s+to\b)|respond|send|submit|provide|complete|deliver|mail|bring|renew|appeal|deadline)\b/i;
const PAY_BY = /\bpay\b[\s\S]{0,80}?\bby\b/i;
const PAY_STUB = /\bpay stubs?\b/i;

export function hasDutyWord(text: string): boolean {
  if (DUTY_WORDS.test(text)) return true;
  return PAY_BY.test(text) && !PAY_STUB.test(text);
}

// A stated amount already due or paid is history, not a duty: "The
// amount of $155.56 was due on October 23, 2026."
const DOLLAR_AMOUNT = /\$\s*\d/;
const PAST_DUE = /\b(?:was|were)\s+(?:due|paid)\b|\bpaid\b/i;

export function isHistoryWithAmount(text: string): boolean {
  return DOLLAR_AMOUNT.test(text) && PAST_DUE.test(text);
}

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

export function trimSentence(sentence: string): string {
  return sentence
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^dear\s+[^,]{1,80},\s*/i, "")
    .replace(/[\s.!;:,]+$/, "");
}

function matchForm(s: string): { form: DeadlineForm; groups: Record<string, string | undefined> } | null {
  for (const { form, re } of FORMS) {
    const m = s.match(re);
    if (m?.groups && isDutyClause(m.groups.duty ?? "", false)) return { form, groups: m.groups };
  }
  const due = s.match(DUE_FORM);
  if (due?.groups && isDutyClause(due.groups.duty ?? "", true)) return { form: "due", groups: due.groups };
  return null;
}

export function gateSentence(sentence: string, noticeIso: string | null): GateVerdict {
  const s = trimSentence(sentence);
  if (findAmbiguousDate(s)) return { kind: "ask", reason: "ambiguous-date" };
  const match = matchForm(s);
  if (match) {
    const { form, groups } = match;
    let iso: string;
    let count: DayCount | null = null;
    if (form === "within-days-of-date" || form === "within-days-of-notice") {
      const anchorIso = form === "within-days-of-notice" ? noticeIso : parseWrittenDate(groups.date ?? "");
      if (!anchorIso) return { kind: "ask", reason: "no-notice-date" };
      const days = Number(groups.days);
      iso = addDays(anchorIso, days);
      count = {
        days,
        anchorIso,
        anchorText: form === "within-days-of-date" ? (groups.date ?? null) : null,
      };
    } else {
      const parsed = parseWrittenDate(groups.date ?? "");
      if (!parsed) return { kind: "ask", reason: "unrecognized" };
      iso = parsed;
      if (noticeIso && iso === noticeIso) return { kind: "ask", reason: "notice-date" };
    }
    const chrono = chronologyOf(iso, noticeIso);
    if (chrono !== "ok") return { kind: "ask", reason: chrono };
    return { kind: "deadline", iso, form, obligation: obligationOf(groups.duty ?? s), count };
  }
  const dates = parseAllDates(s);
  if (dates.length === 0 && !ANY_COUNT.test(s)) return { kind: "no-date" };
  const plain = dates.length === 1 && !ANY_COUNT.test(s) && !TO_KNOW_LEFTOVER.test(s);
  if (plain && noticeIso && dates[0] === noticeIso) return { kind: "ask", reason: "notice-date" };
  if (plain && (!hasDutyWord(s) || isHistoryWithAmount(s))) return { kind: "date-to-know", iso: dates[0]! };
  return { kind: "ask", reason: "unrecognized" };
}
