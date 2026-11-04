// The date a deadline tool was handed. The model has no reliable sense of
// today, so its year is never taken on its word: a year counts only when
// the person wrote it next to this date, in English or Spanish, the two
// languages the app serves. Otherwise the calendar decides, in the zone
// of the person's state. Engine stores whatever date it is given and a
// past date gets no nudges, so this is settled before anything is written.
import type { ToolContext } from "eve/tools";

import { localDate } from "./deadlines.js";
import { PROFILE_OPEN } from "./profile.js";

// A date already gone by this year is next year's only when that is this
// near. Further out it more likely means the one that just passed, so
// Mano asks rather than holding it for most of a year.
const NEXT_YEAR_REACH_DAYS = 183;

const MONTHS: readonly (readonly string[])[] = [
  ["january", "enero"], ["february", "febrero"], ["march", "marzo"], ["april", "abril"], ["may", "mayo"], ["june", "junio"],
  ["july", "julio"], ["august", "agosto"], ["september", "septiembre", "setiembre"], ["october", "octubre"], ["november", "noviembre"], ["december", "diciembre"],
];

// Lowercase with no accents, so "próximo año" and "proximo ano" are one
// phrase, and "twenty-seven" reads as two words.
function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(\p{L})-(?=\p{L})/gu, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function iso(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// Years in words, for the years a deadline can plausibly name.
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const UNOS = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
const VEINTES = ["veinte", "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const SPELLED = new Map<string, number>();
for (let n = 20; n < 40; n++) {
  const one = n % 10;
  const en = `${n < 30 ? "twenty" : "thirty"}${one ? ` ${ONES[one]}` : ""}`;
  const es = n < 30 ? VEINTES[one]! : `treinta${one ? ` y ${UNOS[one]}` : ""}`;
  for (const words of [`twenty ${en}`, `two thousand ${en}`, `two thousand and ${en}`, `dos mil ${es}`]) SPELLED.set(words, 2000 + n);
}

// Years counted from this one, as people say them.
const RELATIVE = new Map<string, number>([
  ["next year", 1], ["following year", 1], ["coming year", 1], ["proximo ano", 1], ["ano proximo", 1], ["ano que viene", 1], ["siguiente ano", 1], ["ano siguiente", 1], ["ano entrante", 1],
  ["this year", 0], ["este ano", 0], ["ano en curso", 0], ["presente ano", 0],
  ["last year", -1], ["previous year", -1], ["past year", -1], ["ano pasado", -1], ["pasado ano", -1], ["ano anterior", -1],
]);

const alternatives = (phrases: Iterable<string>) => [...phrases].sort((a, b) => b.length - a.length).join("|");
const RELATIVE_YEAR = alternatives(RELATIVE.keys());
// "del 27" is how Spanish shortens a year; a bare "27" after a date is not a year.
const YEAR = `(?<![\\w'])(?:(?:19|20)\\d{2}|'\\d{2}|(?<=\\bdel )\\d{2}|${alternatives(SPELLED.keys())}|${RELATIVE_YEAR})(?![\\w])`;
const LINK = "(?:(?:of|in|for|de|del|en|el|the)[ ,]+)*";
// "next September 30", "el proximo 30 de septiembre": the next one of that
// date, not next year's. "Last" and "pasado" are the one before. Spanish
// can also say it after the date; English "November 24 next" leads into
// other words ("next week"), so it counts only before.
const NEXT_ONE = "next|this coming|coming|proximo";
const LAST_ONE = "last|pasado";
const ONE_AFTER = "proximo|pasado";

function yearOf(token: string, thisYear: number): number {
  const relative = RELATIVE.get(token);
  if (relative !== undefined) return thisYear + relative;
  const spelled = SPELLED.get(token);
  if (spelled !== undefined) return spelled;
  const digits = Number(token.replace("'", ""));
  return digits < 100 ? 2000 + digits : digits;
}

// A date as written: "2026-11-12", "11/12", "11/12/2026", "November 12",
// "Nov 12, 2026", "24 de noviembre" or "30 de septiembre del proximo ano".
// null when it is not one of these. y is only what the words claim.
function dateParts(words: string, thisYear: number): { y: number | null; m: number; d: number } | null {
  let text = plain(words).replace(/(\d)(st|nd|rd|th|ro)\b/g, "$1").replace(/\b(?:primero|first)\b/g, "1").replace(/,/g, " ").replace(/\s+/g, " ").replace(/^(?:el|the|on) /, "");
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(text);
  if (match) return { y: match[3] ? yearOf(match[3], thisYear) : null, m: Number(match[1]), d: Number(match[2]) };
  let y: number | null = null;
  const year = new RegExp(`[ ,]+${LINK}(${YEAR})$`).exec(text);
  if (year) {
    y = yearOf(year[1]!, thisYear);
    text = text.slice(0, year.index);
  }
  match = /^([a-z]+)\.? (\d{1,2})$/.exec(text);
  const dayFirst = match ? null : /^(\d{1,2}) (?:de |of )?([a-z]+)\.?$/.exec(text);
  const name = match?.[1] ?? dayFirst?.[2];
  const day = match?.[2] ?? dayFirst?.[1];
  if (!name || !day || name.length < 3) return null;
  const month = MONTHS.findIndex((names) => names.some((n) => n.startsWith(name)));
  return month < 0 ? null : { y, m: month + 1, d: Number(day) };
}

// What was written around this tool call, from the model's input for its
// step. person: their messages, oldest first, a letter's text in their
// turn included; the profile block is not them naming a date. asked: Mano's
// last reply before their newest message, for a yes to a date it spelled out.
export interface Said {
  person: string[];
  asked: string | null;
}

export function whatWasSaid(messages: ToolContext["messages"]): Said {
  const textOf = (content: (typeof messages)[number]["content"]) =>
    typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
  const said: Said = { person: [], asked: null };
  let reply: string | null = null;
  for (const m of messages) {
    if (m.role === "assistant") {
      reply = textOf(m.content) || reply;
    } else if (m.role === "user" && !textOf(m.content).includes(PROFILE_OPEN)) {
      said.person.push(textOf(m.content));
      said.asked = reply;
    }
  }
  return said;
}

// Every mention of this month and day in one message: the years written
// next to it, and whether it also appears with none. Only a year in the
// same phrase counts, so a case number or a birth date never does.
function mentions(text: string, m: number, d: number, today: string): { years: number[]; yearless: boolean } {
  const thisYear = Number(today.slice(0, 4));
  const month = alternatives(MONTHS[m - 1]!.flatMap((name) => [name, name.slice(0, 3), ...(m === 9 ? ["sept"] : [])]));
  const day = `(?:0?${d}(?:st|nd|rd|th|ro)?${d === 1 ? "|primero|first" : ""})`;
  const phrase = `(?:(?<!\\w)(?:${month})\\.? (?:the )?${day}(?!\\w)|(?<![\\w/.-])${day} (?:de |of )?(?:${month})(?!\\w)\\.?)`;
  const before = `(?:(?<!\\w)(${RELATIVE_YEAR}|(?:in|en) (?:19|20)\\d{2})[ ,]+(?:(?:on|in|el|the|en)[ ,]+)*|(?<!\\w)(${NEXT_ONE}|${LAST_ONE})[ ,]+(?:(?:the|el)[ ,]+)?)?`;
  const after = `(?:[ ,]+${LINK}(${YEAR}|(?:${ONE_AFTER})(?!\\w)))?`;
  const words = new RegExp(before + phrase + after, "g");
  const numeric = new RegExp(
    `(?<![\\d/.-])(?:((?:19|20)\\d{2})[/-]0?${m}[/-]0?${d}|(?:0?${m}[/.-]0?${d}|0?${d}[/.-]0?${m})[/.-]((?:19|20)\\d{2}|\\d{2}))(?![\\d/.-])`,
    "g",
  );
  const bareNumeric = new RegExp(`(?<![\\d/.-])(?:0?${m}/0?${d}|0?${d}/0?${m})(?![\\d/.-])`);
  const current = iso(thisYear, m, d);
  const nextOne = current && current >= today ? thisYear : thisYear + 1;
  const lastOne = current && current < today ? thisYear : thisYear - 1;
  const isOne = (words: string, set: string) => new RegExp(`^(?:${set})$`).test(words);
  const years = new Set<number>();
  let yearless = bareNumeric.test(text);
  for (const hit of text.matchAll(words)) {
    const [, beforeYear, beforeOne, afterYear] = hit;
    const written = beforeOne ?? beforeYear ?? afterYear;
    if (!written) yearless = true;
    else if (isOne(written, NEXT_ONE)) years.add(nextOne);
    else if (isOne(written, LAST_ONE)) years.add(lastOne);
    else years.add(yearOf(written.replace(/^(?:in|en) /, ""), thisYear));
  }
  for (const hit of text.matchAll(numeric)) years.add(yearOf((hit[1] ?? hit[2])!, thisYear));
  return { years: [...years], yearless };
}

const AGREEING = "yes|yeah|yep|yup|si|claro|correct|right|exactly|exacto|ok|okay|sure|that's right|thats right|eso es";
const BARE_YEAR = new RegExp(`^(?:(?:${AGREEING}|it is|it's|its|es|in|en|of|de|del|el|the|for)[ ,.!]*)*(${YEAR})[ .!?]*$`);
const JUST_YES = new RegExp(`^(?:${AGREEING})[ .!]*$`);

// The years the person gave this date. Their newest message settles it: a
// year on its own, or a yes to a date Mano spelled out, answers Mano's
// question. Otherwise the newest message with a year next to the date
// speaks, and if they have since named the date with no year, a past year
// no longer does: that was another November 24.
function statedYears(m: number, d: number, today: string, said: Said): number[] {
  const thisYear = Number(today.slice(0, 4));
  const person = said.person.map(plain).reverse();
  const newest = person[0] ?? "";
  const bare = BARE_YEAR.exec(newest);
  if (bare) return [yearOf(bare[1]!, thisYear)];
  if (JUST_YES.test(newest) && said.asked) {
    const { years } = mentions(plain(said.asked), m, d, today);
    if (years.length > 0) return years;
  }
  const found = person.map((text) => mentions(text, m, d, today));
  const speaking = found.find((f) => f.years.length > 0);
  if (!speaking) return [];
  const latest = found.find((f) => f.years.length > 0 || f.yearless)!;
  return latest.yearless ? speaking.years.filter((y) => y >= thisYear) : speaking.years;
}

export type DueDate =
  // On or after today. yearChanged: the words carried another year, and
  // the person's words or the calendar replaced it.
  | { status: "live"; date: string; yearChanged: boolean }
  // Before today: never saved as a live deadline.
  | { status: "passed"; date: string }
  // The person gave this date more than one year, and nothing says which.
  | { status: "ask" };

// null when no such date exists near enough to mean anything.
export function resolveDueDate(words: string, nowMs: number, timeZone: string, said: Said): DueDate | null {
  const today = localDate(nowMs, timeZone);
  const thisYear = Number(today.slice(0, 4));
  const parts = dateParts(words, thisYear);
  if (!parts) return null;
  const { y, m, d } = parts;
  const live = (date: string): DueDate => ({ status: "live", date, yearChanged: y !== null && y !== Number(date.slice(0, 4)) });

  const stated = statedYears(m, d, today, said);
  if (stated.length > 0) {
    const year = y !== null && stated.includes(y) ? y : stated.length === 1 ? stated[0]! : null;
    if (year === null) return { status: "ask" };
    const date = iso(year, m, d);
    if (!date) return null;
    return date >= today ? live(date) : { status: "passed", date };
  }
  const current = iso(thisYear, m, d);
  if (current && current >= today) return live(current);
  const next = iso(thisYear + 1, m, d);
  if (next && (Date.parse(next) - Date.parse(today)) / 86_400_000 <= NEXT_YEAR_REACH_DAYS) return live(next);
  return current ? { status: "passed", date: current } : null;
}

// A date that is not written, and what the model is to do about it.
export function notWritten(due: Exclude<DueDate, { status: "live" }>, nowMs: number, timeZone: string) {
  const today = localDate(nowMs, timeZone);
  return due.status === "ask"
    ? { status: due.status, today, tell: "Nothing was saved: the person gave this date more than one year. Ask which one they mean." }
    : {
        status: due.status,
        dueDate: due.date,
        today,
        tell: `Nothing was saved: ${due.date} has already passed (today is ${today}), so no reminder goes out for it. Say that plainly. If the person means a date still ahead, ask for it with its year.`,
      };
}
