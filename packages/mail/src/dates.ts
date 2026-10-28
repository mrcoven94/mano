// Written-out date parsing. Benefit letters write dates as words
// ("November 20, 2026"), so ISO-only matching misses them. This parses
// the common US letter forms into YYYY-MM-DD, or returns null.

import type { Obligation } from "./types.js";

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function toIso(year: number, month: number, day: number): string | null {
  if (!validDate(year, month, day)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Matches "November 20, 2026", "Nov 20 2026", "20 November 2026",
// "11/20/2026", "11-20-2026", "2026-11-20". Returns the first match in
// the text, or null. Numerics that read two ways ("03/04/2027") or
// cannot be month-first ("13/04/2027") are refused; the caller asks
// the person instead of guessing.
export function parseWrittenDate(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ");

  const monthNames = Object.keys(MONTHS).join("|");
  const mdy = new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i");
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\.?\\s*,?\\s*(\\d{4})\\b`, "i");
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
  const numericDash = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/;

  const candidates: { index: number; iso: string | null }[] = [];
  const tryMatch = (re: RegExp, build: (m: RegExpMatchArray) => string | null) => {
    const m = cleaned.match(re);
    if (m && m.index !== undefined) candidates.push({ index: m.index, iso: build(m) });
  };
  // Month-first only when the day part rules out the alternative.
  const numericBuild = (m: RegExpMatchArray): string | null => {
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12 || second <= 12) return null;
    return toIso(Number(m[3]), first, second);
  };
  tryMatch(mdy, (m) => toIso(Number(m[3]), MONTHS[m[1].toLowerCase()]!, Number(m[2])));
  tryMatch(dmy, (m) => toIso(Number(m[3]), MONTHS[m[2].toLowerCase()]!, Number(m[1])));
  tryMatch(numeric, numericBuild);
  tryMatch(numericDash, numericBuild);
  tryMatch(iso, (m) => toIso(Number(m[1]), Number(m[2]), Number(m[3])));

  candidates.sort((a, b) => a.index - b.index);
  for (const c of candidates) {
    if (c.iso) return c.iso;
  }
  return null;
}

// Dates that must not resolve silently: two-way numerics and yearless
// month-day phrases. Returns the expression, or null.
export function findAmbiguousDate(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ");
  const numeric = cleaned.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if ((first <= 12 && second <= 12) || first > 12) return numeric[0];
  }
  const monthNames = Object.keys(MONTHS).join("|");
  const yearless = cleaned.match(
    new RegExp(`\\b(${monthNames})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})`, "i"),
  );
  if (yearless) return yearless[0];
  return null;
}

// Deadline resolution. Absolute dates pass through. Relative
// expressions ("within 10 days of November 25, 2026", "60 days from
// the date of this notice") resolve by counting from an anchor: a date
// named in the expression, or the notice date when the expression
// points at it. Counting is calendar days unless the letter says
// business days. A date inside relative wording is never promoted to
// the deadline, and a missing or unclear anchor asks the person.
export type ResolvedDeadline =
  | { kind: "absolute"; iso: string }
  | {
      kind: "relative";
      iso: string;
      anchorIso: string;
      anchorText: string;
      anchorSource: "expression" | "notice-date";
      count: number;
      countRule: "calendar days" | "business days";
    }
  | { kind: "needs-anchor"; expression: string }
  | { kind: "ambiguous"; expression: string }
  | { kind: "unsupported"; expression: string }
  | { kind: "none" };

const RELATIVE_AFTER = /(\d{1,3})\s+(business\s+|calendar\s+)?days?\s+(?:from|after)\b([\s\S]*)/i;
const RELATIVE_WITHIN = /\b(?:within|in)\s+(\d{1,3})\s+(business\s+|calendar\s+)?days?\b([\s\S]*)/i;
const NOTICE_ANCHOR = /date of this notice|notice date|this notice|the notice/i;
// Directions and caps the counter does not support. "10 days before
// November 25" and "no later than November 30" following a count ask,
// never resolve; bare "before December 12" still reads as the date
// itself, because the date named is the deadline.
const UNSUPPORTED_REST = /\b(before|prior to|earlier than|preceding|no later than|at the latest)\b/i;
// A count with a time unit that the two supported patterns did not
// match: "10 days before November 25", "within 2 weeks of receipt".
// The parser cannot count it, so it must ask, never promote a nearby
// date. Bare "before December 12" is not relative-like: the date it
// names is the deadline itself.
const RELATIVE_LIKE = /\b\d{1,3}\s+(?:business\s+|calendar\s+)?(?:days?|weeks?|months?|years?)\b/i;

function shiftDate(anchorIso: string, count: number, business: boolean): string | null {
  const [y, m, d] = anchorIso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d));
  let added = 0;
  let guard = 0;
  while (added < count && guard < 1000) {
    guard += 1;
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (!business || (day !== 0 && day !== 6)) added += 1;
  }
  if (added < count) return null;
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function resolveDeadline(deadlineText: string | null, noticeDateText: string | null): ResolvedDeadline {
  if (!deadlineText || !deadlineText.trim()) return { kind: "none" };
  const text = deadlineText.replace(/\s+/g, " ").trim();
  const rel = text.match(RELATIVE_AFTER) ?? text.match(RELATIVE_WITHIN);
  if (!rel) {
    if (RELATIVE_LIKE.test(text)) return { kind: "unsupported", expression: text };
    // An ambiguous date anywhere in the expression asks, even when
    // another date in it would parse. So does a second date: one
    // expression holds one deadline.
    const ambiguous = findAmbiguousDate(text);
    if (ambiguous) return { kind: "ambiguous", expression: ambiguous };
    const iso = parseWrittenDate(text);
    if (!iso) return { kind: "none" };
    if (parseAllDates(text).length > 1) return { kind: "ambiguous", expression: text };
    return { kind: "absolute", iso };
  }
  const count = Number(rel[1]);
  const business = /business/i.test(rel[2] ?? "");
  const rest = (rel[3] ?? "").trim();
  if (UNSUPPORTED_REST.test(rest)) return { kind: "unsupported", expression: text };
  const ambiguous = findAmbiguousDate(rest);
  if (ambiguous) return { kind: "ambiguous", expression: ambiguous };
  // Anchor named in the expression wins.
  const anchorInText = rest ? parseWrittenDate(rest) : null;
  if (anchorInText) {
    if (parseAllDates(rest).length > 1) return { kind: "ambiguous", expression: text };
    const iso = shiftDate(anchorInText, count, business);
    if (!iso) return { kind: "needs-anchor", expression: text };
    return {
      kind: "relative",
      iso,
      anchorIso: anchorInText,
      anchorText: rest
        .replace(/^[,\s]+/, "")
        .replace(/^of\s+/i, "")
        .replace(/[.,;\s]+$/, "")
        .slice(0, 120),
      anchorSource: "expression",
      count,
      countRule: business ? "business days" : "calendar days",
    };
  }
  // Otherwise the expression must point at the notice date.
  if (NOTICE_ANCHOR.test(rest) || NOTICE_ANCHOR.test(text)) {
    const anchorIso = noticeDateText ? parseWrittenDate(noticeDateText) : null;
    if (!anchorIso) return { kind: "needs-anchor", expression: text };
    const iso = shiftDate(anchorIso, count, business);
    if (!iso) return { kind: "needs-anchor", expression: text };
    return {
      kind: "relative",
      iso,
      anchorIso,
      anchorText: "the date of this notice",
      anchorSource: "notice-date",
      count,
      countRule: business ? "business days" : "calendar days",
    };
  }
  return { kind: "needs-anchor", expression: text };
}

// The duty a deadline sentence puts on the resident, read from its
// verbs. Dates within one duty are compared with each other; anything
// without a duty word is other, and unknown duties cannot be compared
// by kind.
export function obligationOf(deadlineText: string): Obligation {
  const t = deadlineText.toLowerCase();
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

// A deadline before the notice date, or more than a year after it, is
// withheld and asked about instead of published. Without a notice date
// there is nothing to check against.
export function chronologyOf(deadlineIso: string, noticeIso: string | null): "ok" | "before-notice" | "too-far" {
  if (!noticeIso) return "ok";
  if (deadlineIso < noticeIso) return "before-notice";
  const [y, m, d] = noticeIso.split("-").map(Number);
  const limit = new Date(Date.UTC(y! + 1, m! - 1, d));
  const limitIso = `${limit.getUTCFullYear()}-${pad(limit.getUTCMonth() + 1)}-${pad(limit.getUTCDate())}`;
  if (deadlineIso > limitIso) return "too-far";
  return "ok";
}

// Every date found in reading order.
export function parseAllDates(text: string): string[] {
  const out: string[] = [];
  const cleaned = text.replace(/\s+/g, " ");
  const monthNames = Object.keys(MONTHS).join("|");
  const patterns: RegExp[] = [
    new RegExp(`\\b(${monthNames})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "gi"),
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(${monthNames})\\.?\\s*,?\\s*\\d{4}\\b`, "gi"),
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
    /\b\d{1,2}-\d{1,2}-\d{4}\b/g,
    /\b20\d{2}-\d{2}-\d{2}\b/g,
  ];
  const hits: { index: number; text: string }[] = [];
  for (const re of patterns) {
    for (const m of cleaned.matchAll(re)) {
      if (m.index !== undefined) hits.push({ index: m.index, text: m[0] });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  for (const h of hits) {
    const iso = parseWrittenDate(h.text);
    if (iso && !out.includes(iso)) out.push(iso);
  }
  return out;
}
