// Written-out date parsing. Benefit letters write dates as words
// ("November 20, 2026"), so ISO-only matching misses them. This parses
// the common US letter forms into YYYY-MM-DD, or returns null.

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
  | { kind: "none" };

const RELATIVE_AFTER = /(\d{1,3})\s+(business\s+|calendar\s+)?days?\s+(?:from|after)\b([\s\S]*)/i;
const RELATIVE_WITHIN = /\b(?:within|in)\s+(\d{1,3})\s+(business\s+|calendar\s+)?days?\b([\s\S]*)/i;
const NOTICE_ANCHOR = /date of this notice|notice date|this notice|the notice/i;

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
    const iso = parseWrittenDate(text);
    if (iso) return { kind: "absolute", iso };
    const ambiguous = findAmbiguousDate(text);
    if (ambiguous) return { kind: "ambiguous", expression: ambiguous };
    return { kind: "none" };
  }
  const count = Number(rel[1]);
  const business = /business/i.test(rel[2] ?? "");
  const rest = (rel[3] ?? "").trim();
  // Anchor named in the expression wins.
  const anchorInText = rest ? parseWrittenDate(rest) : null;
  if (anchorInText) {
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
