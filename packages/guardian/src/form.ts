// The sandbox portal's renewal form (PORTAL_HOUSEHOLD in Engine's
// executors), as Guardian reads it. A personal field reaches Guardian only
// as its kind's label, and its value is removed anywhere else in the
// request. A label would hide any other text in the field from Guardian,
// such as an instruction or an extra destination, so a personal field must
// hold only its kind of value: a name, a date, a mailing address, a phone
// number. formProblems names each field that does not, and the check holds
// the action without sending anything. Number fields reach Guardian as
// numbers, so it can judge whether a household size or income makes sense.
import { digitRuns, readWholeDate, tokenize, type EntityKind } from "./known.js";
import type { CheckInput } from "./types.js";

export type FormField =
  | { kind: "personal"; entity: EntityKind; reads: (value: string) => boolean; problem: string }
  | { kind: "number" };

function personal(entity: EntityKind, what: string, noun: string, reads: (value: string) => boolean): FormField {
  return {
    kind: "personal",
    entity,
    reads,
    problem: `The ${what} on the form does not look like ${noun}, so this action is on hold.`,
  };
}

function clean(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

// Words of letters joined by spaces, hyphens, apostrophes, periods or
// commas: "Inés Synthetic-Ruiz", "Synthetic, Maria", "Leo Synthetic Jr."
// The length matches what Mano's form filler accepts for a name.
const NAME = /^[\p{L}\p{M}]+(?:[ '’.,-]+[\p{L}\p{M}]+)*\.?$/u;
const MAX_NAME_WORDS = 8;

function isName(value: string): boolean {
  const text = clean(value);
  return text.length <= 200 && NAME.test(text) && text.split(/[ ,]+/).length <= MAX_NAME_WORDS;
}

// The same rule as a phone on the person's profile.
function isPhone(value: string): boolean {
  const text = value.normalize("NFKC").trim();
  const digits = text.replace(/\D/g, "").length;
  return /^[0-9+().\s-]+$/.test(text) && digits >= 7 && digits <= 15;
}

// No @, colon or other mark a link or an email needs, and no number long
// enough to be a phone except a ZIP+4. The length matches what Mano's form
// filler accepts for an address.
const ADDRESS = /^[\p{L}\p{M}\p{N}\s,.#&()'’/-]+$/u;
const MAX_ADDRESS_TOKENS = 20;

function isAddress(value: string): boolean {
  const text = value.normalize("NFKC").trim();
  if (text.length > 300 || !ADDRESS.test(text)) return false;
  const tokens = tokenize(text);
  if (tokens.length > MAX_ADDRESS_TOKENS) return false;
  if (!tokens.some((token) => token.digits) || !tokens.some((token) => !token.digits)) return false;
  return digitRuns(tokens).every(
    (run) => run.digits.length < 7 || (run.parts.length === 2 && run.parts[0]?.length === 5 && run.parts[1]?.length === 4),
  );
}

function isDate(value: string): boolean {
  return readWholeDate(value).length > 0;
}

export const SUBMIT_FORM_FIELDS: Record<string, FormField> = {
  fullName: personal("names", "full name", "a name", isName),
  dateOfBirth: personal("datesOfBirth", "date of birth", "a date", isDate),
  address: personal("addresses", "mailing address", "a mailing address", isAddress),
  phone: personal("phones", "phone number", "a phone number", isPhone),
  householdSize: { kind: "number" },
  monthlyIncome: { kind: "number" },
};

// The form a submit carries, or null for any other action.
export function submitForm(input: CheckInput): Record<string, unknown> | null {
  const raw = input.action.payload;
  return input.action.type === "submit" && typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

// A personal field's text, or null when it is missing, empty or not text.
export function fieldText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function formProblems(input: CheckInput): string[] {
  const form = submitForm(input);
  if (form === null) return [];
  return Object.entries(SUBMIT_FORM_FIELDS).flatMap(([name, field]) => {
    if (field.kind !== "personal") return [];
    const text = fieldText(form[name]);
    return text === null || field.reads(text) ? [] : [field.problem];
  });
}
