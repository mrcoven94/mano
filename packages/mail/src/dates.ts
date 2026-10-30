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
// month-day phrases. Returns the expression, or null. Every numeric
// is checked, not just the first: a clear date never clears a later
// ambiguous one.
export function findAmbiguousDate(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ");
  for (const numeric of cleaned.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if ((first <= 12 && second <= 12) || first > 12) return numeric[0];
  }
  const monthNames = Object.keys(MONTHS).join("|");
  const yearless =
    cleaned.match(new RegExp(`\\b(${monthNames})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})`, "i")) ??
    cleaned.match(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(${monthNames})\\b(?!\\.?\\s*,?\\s*\\d{4})`, "i"));
  if (yearless) return yearless[0];
  return null;
}

// One full date with its year, in any form parseWrittenDate reads, as
// a regex source for building whole-sentence patterns.
const MONTH_NAMES = Object.keys(MONTHS).join("|");
export const DATE_PATTERN =
  `(?:(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}` +
  `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_NAMES})\\.?\\s*,?\\s*\\d{4}` +
  `|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}|20\\d{2}-\\d{2}-\\d{2})`;

// A salutation is a whole line: "Dear" plus a short name, ending in an
// optional comma or colon. Only that line is removed. A "Dear" line
// with anything else on it stays, so its sentence fails the gate and
// asks instead of losing a condition.
const SALUTATION_LINE = /^[ \t]*dear(?:[ \t]+[A-Za-z][A-Za-z.'-]*){1,5}[ \t]*[,:]?[ \t]*$/gim;

// "15 Nov. 2026" must not end a sentence at "Nov.": abbreviated month
// names lose their period before anything is split.
export function normalizeMonthAbbreviations(text: string): string {
  return text.replace(/\b(jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\./gi, "$1");
}

// The transcription's sentences. Sentences end at end punctuation, a
// blank line or a salutation line, so a letterhead never runs into the
// body. Whitespace is collapsed and trailing punctuation removed.
export function splitSentences(fullText: string): string[] {
  return normalizeMonthAbbreviations(fullText)
    .replace(SALUTATION_LINE, "\n\n")
    .split(/(?<=[.!?])\s+|\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim().replace(/[\s.!;:,]+$/, ""))
    .filter((s) => s.length > 0);
}

// The header block runs from the top of the page to the salutation or
// the first line that ends a sentence. A notice or letter date counts
// as the header date only on a line of its own there, with at most a
// label before it.
const HEADER_DATE_LINE = new RegExp(
  String.raw`^\s*(?:(?:notice\s+date|date\s+of\s+notice|letter\s+date|date\s+mailed|mailing\s+date|issue\s+date|dated|date)\s*:?\s*)?(${DATE_PATTERN})\s*$`,
  "i",
);

export function headerDates(fullText: string): string[] {
  const out: string[] = [];
  for (const line of normalizeMonthAbbreviations(fullText).split("\n")) {
    if (/^\s*dear\b/i.test(line) || /[.!?]\s*$/.test(line)) break;
    const m = line.match(HEADER_DATE_LINE);
    const iso = m ? parseWrittenDate(m[1]!) : null;
    if (iso) out.push(iso);
  }
  return out;
}

// The letter's sentences as written, for quoting to the person: only
// whitespace is collapsed. A salutation line and each list item stand
// alone, and "15 Nov. 2026" or a "3." list marker never ends one.
const MONTH_ABBR = "(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";
const LIST_MARKER = /^(?:\d{1,2}[.)]|[-\u2022*])\s+/;
const QUOTE_BREAK = new RegExp(String.raw`(?<=[.!?])(?<!\b${MONTH_ABBR}\.)(?<!^\d{1,2}[.)])\s+`, "i");

export function verbatimSentences(fullText: string): string[] {
  return fullText
    .replace(SALUTATION_LINE, "\n\n$&\n\n")
    .split(/\n\s*\n|\n(?=[ \t]*(?:\d{1,2}[.)]|[-\u2022*])[ \t])/)
    .flatMap((block) => block.replace(/\s+/g, " ").trim().split(QUOTE_BREAK))
    .map((s) => s.trim().replace(LIST_MARKER, ""))
    .filter((s) => s.length > 0);
}

// The one sentence of the original transcription that contains the
// extracted text, ignoring case and whitespace. Null when no sentence
// or more than one contains it: the extraction is never gated in its
// place.
export function recoverSentence(text: string, fullText: string): string | null {
  const want = normalizeMonthAbbreviations(text).replace(/\s+/g, " ").trim().replace(/[\s.!;:,]+$/, "").toLowerCase();
  if (want.length < 2) return null;
  const found = [...new Set(splitSentences(fullText).filter((s) => s.toLowerCase().includes(want)))];
  return found.length === 1 ? found[0]! : null;
}

// Every date the parser accepts, in reading order, once per
// occurrence. With a reference date (the notice date), dates written
// without a year ("15 November", "November 15") count too, resolved to
// their first occurrence on or after the reference.
export function dateOccurrences(text: string, refIso: string | null = null): string[] {
  const cleaned = normalizeMonthAbbreviations(text).replace(/\s+/g, " ");
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
  if (refIso) {
    const yearless: RegExp[] = [
      new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})`, "gi"),
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\b(?!\\.?\\s*,?\\s*\\d{4})`, "gi"),
    ];
    yearless.forEach((re, k) => {
      for (const m of cleaned.matchAll(re)) {
        const month = k === 0 ? m[1]! : m[2]!;
        const day = k === 0 ? m[2]! : m[1]!;
        const iso = resolveYear(MONTHS[month.toLowerCase()]!, Number(day), refIso);
        if (iso && m.index !== undefined) hits.push({ index: m.index, text: iso });
      }
    });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => parseWrittenDate(h.text)).filter((iso): iso is string => iso !== null);
}

function resolveYear(month: number, day: number, refIso: string): string | null {
  const refYear = Number(refIso.slice(0, 4));
  const sameYear = toIso(refYear, month, day);
  if (sameYear && sameYear >= refIso) return sameYear;
  return toIso(refYear + 1, month, day);
}

// Every distinct date in reading order.
export function parseAllDates(text: string, refIso: string | null = null): string[] {
  return [...new Set(dateOccurrences(text, refIso))];
}
