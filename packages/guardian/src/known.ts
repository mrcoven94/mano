// Finds the person's own values in text however they are written.
//
// Text and values are read the same way. Each character is folded
// (compatibility decomposition, accents and invisible format characters
// dropped, lower case), runs of letters or of digits become tokens, and
// anything else separates them. A value matches where its tokens appear in
// order, so spacing, punctuation, case and Unicode form never matter. A
// name also matches by each of its words, so a first name alone is caught.
// Phones, ZIP codes and case numbers also match on their digits alone, and
// a birth date matches wherever text names the same day in a common US or
// Spanish format.

export interface KnownEntities {
  names?: string[];
  employers?: string[];
  addresses?: string[];
  phones?: string[];
  emails?: string[];
  datesOfBirth?: string[];
  caseNumbers?: string[];
}

export type EntityKind = keyof KnownEntities;

export const KNOWN_LABELS: Record<EntityKind, string> = {
  names: "[NAME]",
  employers: "[EMPLOYER]",
  addresses: "[ADDRESS]",
  phones: "[PHONE]",
  emails: "[EMAIL]",
  datesOfBirth: "[DATE OF BIRTH]",
  caseNumbers: "[CASE NUMBER]",
};

export function mergeEntities(...sets: (KnownEntities | undefined)[]): KnownEntities {
  const merged: KnownEntities = {};
  for (const set of sets) {
    for (const kind of Object.keys(KNOWN_LABELS) as EntityKind[]) {
      const values = set?.[kind] ?? [];
      if (values.length > 0) merged[kind] = [...(merged[kind] ?? []), ...values];
    }
  }
  return merged;
}

export interface Token {
  text: string;
  digits: boolean;
  // Where the token sits in the original text, so a match replaces the
  // original characters.
  start: number;
  end: number;
  // Labels already written split text into segments. A match never
  // crosses one or reads a label's own words.
  segment: number;
}

const LABEL =
  /\[(?:NAME|EMPLOYER|ADDRESS|PHONE|EMAIL|DATE OF BIRTH|DATE|CASE NUMBER|ID|RECIPIENT|DOCUMENT)\]|\[(?:EMAIL|PHONE|URL|OTHER)-\d+\]/g;

function fold(ch: string): string {
  return ch.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "").toLowerCase();
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const labels = [...text.matchAll(LABEL)];
  let nextLabel = 0;
  let segment = 0;
  let current: Token | null = null;
  let index = 0;
  while (index < text.length) {
    const label = labels[nextLabel];
    if (label !== undefined && label.index === index) {
      index += label[0].length;
      nextLabel += 1;
      segment += 1;
      current = null;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const end = index + ch.length;
    const folded = fold(ch);
    if (folded === "" && current !== null) current.end = end;
    for (const c of folded) {
      const digits = /\p{Nd}/u.test(c);
      if (!digits && !/\p{L}/u.test(c)) {
        current = null;
        continue;
      }
      if (current === null || current.digits !== digits) {
        current = { text: "", digits, start: index, end, segment };
        tokens.push(current);
      }
      current.text += c;
      current.end = end;
    }
    index = end;
  }
  return tokens;
}

function words(value: string): string[] {
  return tokenize(value).map((token) => token.text);
}

// Dates. readDates lists every date that can start at token i, with the
// token where each reading ends, so 01/02/1990 reads as both January 2 and
// February 1, and a two-digit year as both 19xx and 20xx.

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, enero: 1,
  february: 2, feb: 2, febrero: 2,
  march: 3, mar: 3, marzo: 3,
  april: 4, apr: 4, abril: 4,
  may: 5, mayo: 5,
  june: 6, jun: 6, junio: 6,
  july: 7, jul: 7, julio: 7,
  august: 8, aug: 8, agosto: 8,
  september: 9, sep: 9, sept: 9, septiembre: 9, setiembre: 9,
  october: 10, oct: 10, octubre: 10,
  november: 11, nov: 11, noviembre: 11,
  december: 12, dec: 12, diciembre: 12,
};
const ORDINALS = new Set(["st", "nd", "rd", "th"]);
const OF = new Set(["of", "de", "del"]);

interface DateReading {
  end: number;
  isos: string[];
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

function yearsOf(text: string): number[] {
  const n = Number(text);
  if (text.length === 4) return [n];
  if (text.length === 2) return [1900 + n, 2000 + n];
  return [];
}

function readDates(tokens: readonly Token[], i: number): DateReading[] {
  const first = tokens[i];
  if (first === undefined) return [];
  const at = (k: number): Token | undefined => {
    const token = tokens[i + k];
    return token !== undefined && token.segment === first.segment ? token : undefined;
  };
  const small = (token: Token | undefined): number | null =>
    token !== undefined && token.digits && token.text.length <= 2 ? Number(token.text) : null;
  const monthOf = (token: Token | undefined): number | undefined =>
    token !== undefined && !token.digits ? MONTHS[token.text] : undefined;
  const skip = (k: number, set: ReadonlySet<string>): number => {
    const token = at(k);
    return token !== undefined && set.has(token.text) ? k + 1 : k;
  };
  const found: DateReading[] = [];
  const add = (length: number, candidates: (string | null)[]): void => {
    const isos = candidates.filter((iso): iso is string => iso !== null);
    if (isos.length > 0) found.push({ end: i + length, isos });
  };

  // One run of digits: 19900101, 01011990, 010190.
  if (first.digits && first.text.length === 8) {
    const s = first.text;
    const part = (from: number, to: number) => Number(s.slice(from, to));
    add(1, [
      isoDate(part(0, 4), part(4, 6), part(6, 8)),
      isoDate(part(4, 8), part(0, 2), part(2, 4)),
      isoDate(part(4, 8), part(2, 4), part(0, 2)),
    ]);
  }
  if (first.digits && first.text.length === 6) {
    const s = first.text;
    const a = Number(s.slice(0, 2));
    const b = Number(s.slice(2, 4));
    const c = Number(s.slice(4, 6));
    add(1, [
      ...yearsOf(s.slice(4, 6)).flatMap((y) => [isoDate(y, a, b), isoDate(y, b, a)]),
      ...yearsOf(s.slice(0, 2)).map((y) => isoDate(y, b, c)),
    ]);
  }

  // Three numbers: 1990-01-01, 1/1/1990, 01-01-90.
  const second = at(1);
  const third = at(2);
  if (first.digits && second?.digits === true && third?.digits === true) {
    if (first.text.length === 4 && small(second) !== null && small(third) !== null) {
      add(3, [isoDate(Number(first.text), Number(second.text), Number(third.text))]);
    }
    const a = small(first);
    const b = small(second);
    if (a !== null && b !== null) {
      add(3, yearsOf(third.text).flatMap((y) => [isoDate(y, a, b), isoDate(y, b, a)]));
    }
  }

  // Month first: January 1, 1990; Jan. 1st 1990; enero 1 de 1990.
  const leading = monthOf(first);
  const leadingDay = small(at(1));
  if (leading !== undefined && leadingDay !== null) {
    const k = skip(skip(2, ORDINALS), OF);
    const year = at(k);
    if (year?.digits === true) add(k + 1, yearsOf(year.text).map((y) => isoDate(y, leading, leadingDay)));
  }

  // Day first: 1 January 1990; 1st of January, 1990; 1 de enero de 1990.
  const day = small(first);
  if (day !== null) {
    let k = skip(skip(1, ORDINALS), OF);
    const month = monthOf(at(k));
    if (month !== undefined) {
      k = skip(k + 1, OF);
      const year = at(k);
      if (year?.digits === true) add(k + 1, yearsOf(year.text).map((y) => isoDate(y, month, day)));
    }
  }
  return found;
}

// Every date the whole value can be read as, in ISO form. Empty when the
// value is not exactly one date.
export function readWholeDate(value: string): string[] {
  const tokens = tokenize(value);
  return [
    ...new Set(
      readDates(tokens, 0)
        .filter((reading) => reading.end === tokens.length)
        .flatMap((reading) => reading.isos),
    ),
  ];
}

// A run of digit tokens with only separators between them, read as one
// string of digits. owner[n] is the token that holds digit n, and parts
// are the tokens' own digits in order.
interface DigitRun {
  digits: string;
  owner: number[];
  parts: string[];
}

export function digitRuns(tokens: readonly Token[]): DigitRun[] {
  const runs: DigitRun[] = [];
  let run: DigitRun | null = null;
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1];
    if (!token.digits) {
      run = null;
      return;
    }
    if (run === null || previous === undefined || previous.segment !== token.segment) {
      run = { digits: "", owner: [], parts: [] };
      runs.push(run);
    }
    run.digits += token.text;
    run.parts.push(token.text);
    for (let n = 0; n < token.text.length; n += 1) run.owner.push(index);
  });
  return runs;
}

// What each kind of value is matched by: token sequences, digit strings
// found inside runs of digits, and birth dates by the day they name.
interface Needles {
  sequences: string[][];
  digits: string[];
  dates: string[];
}

const NAME_PARTICLES = new Set([
  "de", "del", "della", "la", "las", "los", "le", "da", "das", "do", "dos", "di", "du",
  "van", "von", "der", "den", "ten", "ter", "y", "el", "bin", "ibn", "jr", "sr", "ii", "iii", "iv",
]);
const BUSINESS_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "co", "corp", "corporation", "company", "lp", "llp", "pllc", "plc",
]);
const STREET_SUFFIXES = new Set([
  "st", "str", "street", "ave", "av", "avenue", "rd", "road", "blvd", "boulevard", "ln", "lane", "dr", "drive",
  "way", "ct", "court", "pl", "place", "ter", "terrace", "cir", "circle", "hwy", "highway", "pkwy", "parkway",
  "sq", "square", "trl", "trail", "loop", "row", "path", "pike", "aly", "alley", "plz", "plaza", "rte", "route",
]);
// Words in an address that identify no one on their own, so they never
// match alone.
const ADDRESS_WORDS = new Set([
  ...STREET_SUFFIXES,
  "apt", "apartment", "unit", "ste", "suite", "floor", "room", "bldg", "building", "lot", "box",
  "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest",
  "county", "parish", "city", "town", "village", "township", "borough", "the", "and", "usa",
]);

function digitsOf(value: string): string {
  return tokenize(value)
    .filter((token) => token.digits)
    .map((token) => token.text)
    .join("");
}

function phoneDigits(value: string): string[] {
  const all = digitsOf(value);
  const national = all.length === 11 && all.startsWith("1") ? all.slice(1) : all;
  const variants = new Set([all, national]);
  if (national.length === 10) {
    variants.add(`1${national}`);
    variants.add(national.slice(3));
  }
  return [...variants].filter((digits) => digits.length >= 7);
}

const NEEDLES: Record<EntityKind, (value: string) => Partial<Needles>> = {
  names: (value) => {
    const all = words(value);
    return {
      sequences: [
        all,
        [all.join("")],
        ...all.filter((word) => word.length >= 2 && !NAME_PARTICLES.has(word)).map((word) => [word]),
      ],
    };
  },
  employers: (value) => {
    const all = words(value);
    let core = all.length;
    while (core > 1 && BUSINESS_SUFFIXES.has(all[core - 1] ?? "")) core -= 1;
    const trimmed = all.slice(0, core);
    return { sequences: [all, trimmed, [all.join("")], [trimmed.join("")]] };
  },
  addresses: (value) => {
    const all = words(value);
    const streetEnd = all.findIndex((word, index) => index > 0 && STREET_SUFFIXES.has(word));
    const street = streetEnd > 0 ? [all.slice(0, streetEnd + 1), all.slice(1, streetEnd + 1)] : [];
    const identifying = (word: string): boolean =>
      /^\d+$/.test(word) ? word.length >= 5 : word.length >= 3 && !ADDRESS_WORDS.has(word);
    const parts = [...value.split(/[,;\n]/).map(words), ...street, ...all.filter(identifying).map((word) => [word])];
    return {
      sequences: [all, ...parts.filter((sequence) => sequence.some(identifying))],
      digits: all.filter((word) => /^\d{5,}$/.test(word)),
    };
  },
  phones: (value) => {
    const digits = phoneDigits(value);
    return digits.length > 0 ? { digits } : { sequences: [words(value)] };
  },
  emails: (value) => ({ sequences: [words(value)] }),
  datesOfBirth: (value) => {
    const dates = readWholeDate(value);
    return dates.length > 0 ? { dates } : { sequences: [words(value)] };
  },
  caseNumbers: (value) => {
    const digits = digitsOf(value);
    return { sequences: [words(value)], digits: digits.length >= 5 ? [digits] : [] };
  },
};

export interface KnownMatcher {
  sequences: Map<string, { words: string[]; label: string }[]>;
  digits: { digits: string; label: string }[];
  birthDates: Set<string>;
  empty: boolean;
}

export function knownMatcher(known: KnownEntities | undefined): KnownMatcher {
  const matcher: KnownMatcher = { sequences: new Map(), digits: [], birthDates: new Set(), empty: true };
  for (const kind of Object.keys(KNOWN_LABELS) as EntityKind[]) {
    const label = KNOWN_LABELS[kind];
    for (const value of known?.[kind] ?? []) {
      const needles = NEEDLES[kind](value);
      for (const sequence of needles.sequences ?? []) {
        const first = sequence[0];
        if (first === undefined || sequence.join("").length < 2) continue;
        const bucket = matcher.sequences.get(first) ?? [];
        bucket.push({ words: sequence, label });
        matcher.sequences.set(first, bucket);
        matcher.empty = false;
      }
      for (const digits of needles.digits ?? []) {
        matcher.digits.push({ digits, label });
        matcher.empty = false;
      }
      for (const date of needles.dates ?? []) {
        matcher.birthDates.add(date);
        matcher.empty = false;
      }
    }
  }
  return matcher;
}

interface Span {
  from: number;
  to: number;
  label: string;
}

function findSpans(tokens: readonly Token[], matcher: KnownMatcher): Span[] {
  const spans: Span[] = [];
  tokens.forEach((token, i) => {
    for (const needle of matcher.sequences.get(token.text) ?? []) {
      const fits = needle.words.every((word, k) => {
        const other = tokens[i + k];
        return other !== undefined && other.text === word && other.segment === token.segment;
      });
      if (fits) spans.push({ from: i, to: i + needle.words.length, label: needle.label });
    }
    if (matcher.birthDates.size > 0) {
      for (const reading of readDates(tokens, i)) {
        if (reading.isos.some((iso) => matcher.birthDates.has(iso))) {
          spans.push({ from: i, to: reading.end, label: KNOWN_LABELS.datesOfBirth });
        }
      }
    }
  });
  for (const run of digitRuns(tokens)) {
    for (const needle of matcher.digits) {
      for (let at = run.digits.indexOf(needle.digits); at !== -1; at = run.digits.indexOf(needle.digits, at + 1)) {
        const from = run.owner[at];
        const last = run.owner[at + needle.digits.length - 1];
        if (from !== undefined && last !== undefined) spans.push({ from, to: last + 1, label: needle.label });
      }
    }
  }
  return spans;
}

// Overlapping matches become one region, labeled by its longest match, so
// no token of any match survives. Neighbors with the same label and only
// whitespace between them become one region too, so "San Francisco" is
// one [ADDRESS].
function regions(spans: Span[], tokens: readonly Token[], text: string): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
  const merged: (Span & { width: number })[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    const width = span.to - span.from;
    if (last !== undefined && span.from < last.to) {
      if (width > last.width) {
        last.label = span.label;
        last.width = width;
      }
      last.to = Math.max(last.to, span.to);
      continue;
    }
    const before = tokens[span.from - 1];
    const here = tokens[span.from];
    if (
      last !== undefined &&
      span.from === last.to &&
      span.label === last.label &&
      before !== undefined &&
      here !== undefined &&
      before.segment === here.segment &&
      text.slice(before.end, here.start).trim() === ""
    ) {
      last.to = span.to;
      continue;
    }
    merged.push({ ...span, width });
  }
  return merged;
}

export function replaceKnown(text: string, matcher: KnownMatcher): string {
  if (matcher.empty) return text;
  const tokens = tokenize(text);
  let out = "";
  let at = 0;
  for (const region of regions(findSpans(tokens, matcher), tokens, text)) {
    const first = tokens[region.from];
    const last = tokens[region.to - 1];
    if (first === undefined || last === undefined) continue;
    out += text.slice(at, first.start) + region.label;
    at = last.end;
  }
  return out + text.slice(at);
}
