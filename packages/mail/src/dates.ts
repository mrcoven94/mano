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
// the text, or null.
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
  tryMatch(mdy, (m) => toIso(Number(m[3]), MONTHS[m[1].toLowerCase()]!, Number(m[2])));
  tryMatch(dmy, (m) => toIso(Number(m[3]), MONTHS[m[2].toLowerCase()]!, Number(m[1])));
  tryMatch(numeric, (m) => toIso(Number(m[3]), Number(m[1]), Number(m[2])));
  tryMatch(numericDash, (m) => toIso(Number(m[3]), Number(m[1]), Number(m[2])));
  tryMatch(iso, (m) => toIso(Number(m[1]), Number(m[2]), Number(m[3])));

  candidates.sort((a, b) => a.index - b.index);
  for (const c of candidates) {
    if (c.iso) return c.iso;
  }
  return null;
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
