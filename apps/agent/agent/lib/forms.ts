// The forms Mano knows how to fill, as a table: each form names its
// fields in the form's own words, where each value comes from in the
// profile, the one question to ask when it is missing, and how a value
// is checked. Only forms on our own sandbox portal are listed (hard rule
// 2): a resident's real portal is never a target.
//
// Text goes on a form exactly as the person or their letter gave it, with
// the spaces around it dropped and each run of spaces inside it made one
// space, so the person approves exactly what is filed; a date or an amount
// is only written the way the form's field stores it. Nothing is invented, defaulted, shortened or
// changed to fit: a value that is missing, or does not fit its field,
// becomes one plain question, asked in the form's order of importance.

import type { RecipientId } from "@mano/protocol";

import type { Frequency, Leaf, Profile } from "./engine.js";
import { confirmedByPerson, householdSizeOf } from "./profile.js";

export interface FormField {
  // The form's own input name, which the filing carries.
  name: string;
  // The label the form shows, used in the exact version the person approves.
  label: string;
  question: string;
  // The value as the profile holds it. It is checked like any answer.
  fromProfile(profile: Profile): string | null;
  // The leaves that value was read from, which say whose word it is.
  readFrom(profile: Profile): (Leaf<unknown> | undefined)[];
  // The checked value, or null when the answer does not fit the field.
  parse(answer: string): string | null;
  // The Engine profile fields that keep this checked value, so fromProfile
  // gives it back on a later call. Empty: the value cannot stand on its own.
  toProfile(value: string, profile: Profile): ProfileFields;
}

export type ProfileFields = Record<string, string | number | boolean | null>;

export interface FormSpec {
  id: string;
  // The form's address on the sandbox portal.
  path: string;
  recipient: RecipientId;
  purpose: string;
  // In the order Mano asks for them, most important first.
  fields: FormField[];
  // The declaration the form ends with, word for word. Only the person
  // makes it, by their own YES to the question that shows it; Mano never
  // answers it for them.
  declaration: string;
  // The one document the form requires, read from the profile: the
  // document a profile value was taken from.
  proof: { label: string; question: string; fromProfile(profile: Profile): string | null };
}

// The text line shows a run of spaces as one, so a value is taken that way
// before it is checked: what the question shows is what is filed.
function taken(answer: string): string {
  return answer.trim().replace(/\s+/g, " ");
}

// One line of text of at most max characters.
function trimmed(max: number) {
  return (answer: string) => {
    const v = taken(answer);
    return v && v.length <= max ? v : null;
  };
}

function isoDate(answer: string): string | null {
  const v = answer.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [y, m, d] = [Number(us[3]), Number(us[1]), Number(us[2])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (date.getTime() > Date.now() || y < 1900) return null;
  return date.toISOString().slice(0, 10);
}

function phone(answer: string): string | null {
  const v = taken(answer);
  const digits = v.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1")) ? v : null;
}

function wholeNumber(min: number, max: number) {
  return (answer: string) => {
    const v = answer.trim();
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n >= min && n <= max ? String(n) : null;
  };
}

function dollars(answer: string): string | null {
  const v = answer.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return String(Number(v));
}

const PER_MONTH: Record<Frequency, number> = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12 };

// A value the person gave for a form stands until they change a fact it
// summarizes. A document or a note ranks below their word, so neither
// replaces it, however new.
function stands(given: Leaf<unknown>, facts: (Leaf<unknown> | undefined)[]): boolean {
  return !facts.some((f) => f?.source === "person" && f.updatedAt > given.updatedAt);
}

// The form asks for one household total. It is kept as its own entry and
// never added to the others, which it already counts. Changed to anything
// but monthly, it is an entry like the others.
const STATED_TOTAL = "stated-monthly-total";

function incomeOnFile(profile: Profile): { stated: Leaf<number> | null; entries: Profile["income"] } {
  const own = profile.income.find((i) => i.id === STATED_TOTAL);
  if (own?.frequency?.value !== "monthly" || !own.amount) return { stated: null, entries: profile.income };
  const entries = profile.income.filter((i) => i !== own);
  return { stated: stands(own.amount, entries.flatMap((i) => [i.amount, i.frequency])) ? own.amount : null, entries };
}

// The total the person gave, if it stands. Otherwise unknown unless every
// entry has an amount and how often it comes: a total that left one out
// would understate the household's income.
function monthlyIncome(profile: Profile): string | null {
  const { stated, entries } = incomeOnFile(profile);
  if (stated) return String(stated.value);
  if (entries.length === 0) return null;
  let total = 0;
  for (const i of entries) {
    if (!i.amount || !i.frequency) return null;
    total += i.amount.value * PER_MONTH[i.frequency.value];
  }
  return String(Math.round(total));
}

const ENDS_IN_ZIP = /\b\d{5}(-\d{4})?$/;
const ADDRESS_PARTS = /^(.+?), (?:(.+), )?([^,]+), ([A-Za-z]{2}),? (\d{5}(?:-\d{4})?)$/;
// What Engine keeps in one line of text.
const ADDRESS_LINE_MAX = 200;

// An address given in one line that could not be split into parts is kept
// whole on its first line, and is complete if it ends in a ZIP.
function mailingAddress(profile: Profile): string | null {
  const a = profile.person.address;
  if (!a?.line1) return null;
  if (!a.city || !a.state || !a.zip) return ENDS_IN_ZIP.test(a.line1.value) ? a.line1.value : null;
  return [a.line1.value, a.line2?.value, a.city.value, `${a.state.value} ${a.zip.value}`].filter(Boolean).join(", ");
}

// Nothing without a ZIP: part of an address must not replace a whole one.
function addressFields(value: string): ProfileFields {
  if (!ENDS_IN_ZIP.test(value) || value.length > ADDRESS_LINE_MAX) return {};
  const [, line1, line2, city, state, zip] = ADDRESS_PARTS.exec(value) ?? [];
  const at = (part: string) => `person.address.${part}`;
  if (!line1) return { [at("line1")]: value, [at("line2")]: null, [at("city")]: null, [at("state")]: null, [at("zip")]: null };
  return { [at("line1")]: line1, [at("line2")]: line2 ?? null, [at("city")]: city!, [at("state")]: state!, [at("zip")]: zip! };
}

const FOOD_PROGRAM = /\b(snap|calfresh|food)\b/i;
// The entry that keeps the number the person gave when no one case on file
// is the one to write it to, so no other case is changed.
const GIVEN_CASE = "food";

// The food cases this renewal could be: none in another state than hers.
function foodCases(profile: Profile): Profile["programs"] {
  const state = profile.person.address?.state?.value.toUpperCase();
  return profile.programs.filter(
    (p) => p.id !== GIVEN_CASE && p.program && FOOD_PROGRAM.test(p.program.value) && (!state || !p.state || p.state.value.toUpperCase() === state),
  );
}

function givenCase(profile: Profile): Leaf | null {
  const given = profile.programs.find((p) => p.id === GIVEN_CASE)?.caseNumber;
  return given && stands(given, foodCases(profile).map((p) => p.caseNumber)) ? given : null;
}

// The number she gave, if it stands, or the one number on her food cases.
// Two different numbers are not chosen between; the person is asked.
function foodCaseNumber(profile: Profile): string | null {
  const given = givenCase(profile);
  if (given) return given.value;
  const numbers = new Set(foodCases(profile).flatMap((p) => (p.caseNumber ? [p.caseNumber.value] : [])));
  return numbers.size === 1 ? [...numbers][0]! : null;
}

// Clearing an entry and setting it in one patch writes it as new even when
// the value is the same, so the person restating it counts as their latest word.
function caseNumberFields(value: string, profile: Profile): ProfileFields {
  const given = `programs.${GIVEN_CASE}`;
  const cases = foodCases(profile);
  if (cases.length === 1) return { [`programs.${cases[0]!.id}.caseNumber`]: value, [given]: null };
  return { [given]: null, [`${given}.program`]: "Food benefits", [`${given}.caseNumber`]: value };
}

// The pay stub or other document an income amount was read from.
function incomeDocument(profile: Profile): string | null {
  return profile.income.find((i) => i.amount?.source === "document" && i.amount.documentId)?.amount?.documentId ?? null;
}

const FOOD_RENEWAL: FormSpec = {
  id: "food-renewal",
  path: "/apply",
  recipient: "sandbox-agency-portal",
  purpose: "Food benefits renewal",
  fields: [
    // Which case this is and whose: the office cannot match a renewal without them.
    {
      name: "caseNumber",
      label: "Case number",
      question: "What is the case number on your renewal letter?",
      fromProfile: foodCaseNumber,
      readFrom: (p) => {
        const given = givenCase(p);
        return given ? [given] : foodCases(p).map((c) => c.caseNumber);
      },
      parse: trimmed(40),
      toProfile: caseNumberFields,
    },
    {
      name: "fullName",
      label: "Full legal name",
      question: "What is your full legal name, as it appears on your benefits letters?",
      fromProfile: (p) => p.person.fullName?.value ?? null,
      readFrom: (p) => [p.person.fullName],
      parse: trimmed(200),
      toProfile: (value) => ({ "person.fullName": value }),
    },
    {
      name: "dateOfBirth",
      label: "Date of birth",
      question: "What is your date of birth?",
      fromProfile: (p) => p.person.dateOfBirth?.value ?? null,
      readFrom: (p) => [p.person.dateOfBirth],
      parse: isoDate,
      toProfile: (value) => ({ "person.dateOfBirth": value }),
    },
    // What the benefit is decided on.
    {
      name: "householdSize",
      label: "People in household",
      question: "How many people live in your household, counting you?",
      // Only the person's own confirmation says the list is everyone: one
      // child mentioned in passing is not a household, and a confirmed
      // empty list means they live alone. Or the number they gave.
      fromProfile: (p) => {
        const size = householdSizeOf(p);
        return size === null ? null : String(size);
      },
      readFrom: (p) => [confirmedByPerson(p) ? p.person.householdConfirmed : p.person.householdSize],
      parse: wholeNumber(1, 30),
      // A number that differs replaces the roster's confirmation: the list
      // on file is no longer everyone.
      toProfile: (value, p) => ({ "person.householdSize": Number(value), ...(confirmedByPerson(p) ? { "person.householdConfirmed": null } : {}) }),
    },
    {
      name: "monthlyIncome",
      label: "Monthly income ($)",
      question: "About how much does your household earn in a month, before taxes?",
      fromProfile: monthlyIncome,
      readFrom: (p) => {
        const { stated, entries } = incomeOnFile(p);
        return stated ? [stated] : entries.flatMap((i) => [i.amount, i.frequency]);
      },
      parse: dollars,
      // Cleared and set in one patch, so restating the same total is written
      // as new and stands over an entry that changed since.
      toProfile: (value) => ({
        [`income.${STATED_TOTAL}`]: null,
        [`income.${STATED_TOTAL}.source`]: "Household total the person gave",
        [`income.${STATED_TOTAL}.amount`]: Number(value),
        [`income.${STATED_TOTAL}.frequency`]: "monthly",
      }),
    },
    // How the office reaches her.
    {
      name: "address",
      label: "Mailing address",
      question: "What is your mailing address, with city, state and ZIP?",
      fromProfile: mailingAddress,
      readFrom: (p) => {
        const a = p.person.address;
        return [a.line1, a.line2, a.city, a.state, a.zip];
      },
      parse: trimmed(300),
      toProfile: addressFields,
    },
    {
      name: "phone",
      label: "Phone number",
      question: "What phone number should the office use to reach you?",
      fromProfile: (p) => p.person.phone?.value ?? null,
      readFrom: (p) => [p.person.phone],
      parse: phone,
      toProfile: (value) => ({ "person.phone": value }),
    },
  ],
  declaration:
    "I declare under penalty of perjury that the information in this renewal is true, correct and complete to the best of my knowledge.",
  proof: {
    label: "Proof of income",
    question: "Can you send a photo of your most recent pay stub?",
    fromProfile: incomeDocument,
  },
};

export const FORMS: Record<string, FormSpec> = { [FOOD_RENEWAL.id]: FOOD_RENEWAL };

// A form by its ID, or by its address on our sandbox portal. Any other
// address is refused, so Mano never fills a real portal.
export function resolveForm(ref: string, portalUrl: string | null): FormSpec | null {
  const byId = Object.hasOwn(FORMS, ref.trim()) ? FORMS[ref.trim()] : undefined;
  if (byId) return byId;
  if (!portalUrl) return null;
  let url: URL, portal: URL;
  try {
    url = new URL(ref.trim());
    portal = new URL(portalUrl);
  } catch {
    return null;
  }
  if (url.origin !== portal.origin) return null;
  return Object.values(FORMS).find((f) => url.pathname.replace(/\/$/, "") === f.path) ?? null;
}

export interface FilledForm {
  values: Record<string, string>;
  documentId: string | null;
  // The first field still missing or not fitting its field, in the
  // form's order, or the proof document, or null when the form is complete.
  missing: { name: string; label: string; question: string } | null;
  // Answers the person gave that do not fit their field.
  invalid: { name: string; label: string; question: string }[];
}

// Fills the form from the person's own answers first, then the profile.
// A profile value that does not fit its field is asked about by name,
// never shortened or changed to fit.
export function fillFrom(form: FormSpec, profile: Profile, answers: Record<string, string>): FilledForm {
  const values: Record<string, string> = {};
  const invalid: FilledForm["invalid"] = [];
  let missing: FilledForm["missing"] = null;
  for (const field of form.fields) {
    const ask = { name: field.name, label: field.label, question: field.question };
    const answer = Object.hasOwn(answers, field.name) ? answers[field.name] : undefined;
    const fromAnswer = answer === undefined ? null : field.parse(answer);
    if (answer !== undefined && fromAnswer === null) invalid.push(ask);
    const onFile = fromAnswer === null ? field.fromProfile(profile) : null;
    const value = fromAnswer ?? (onFile === null ? null : field.parse(onFile));
    if (value === null) {
      missing ??= onFile === null ? ask : { ...ask, question: `I have ${onFile.trim()} as your ${field.label.toLowerCase()}, but it does not fit the form. ${field.question}` };
      continue;
    }
    values[field.name] = value;
  }
  const documentId = form.proof.fromProfile(profile);
  if (!documentId) missing ??= { name: "proof", label: form.proof.label, question: form.proof.question };
  return { values, documentId, missing, invalid };
}

// What the person's answers change on their profile, one entry per field:
// every checked answer, unless the profile already gives that value as
// their own word. One that only matches a document's value is still written,
// so it becomes theirs and a later document can only suggest a change.
export function answerChanges(form: FormSpec, profile: Profile, answers: Record<string, string>): { field: string; fields: ProfileFields }[] {
  return form.fields.flatMap((field) => {
    const answer = Object.hasOwn(answers, field.name) ? answers[field.name] : undefined;
    const value = answer === undefined ? null : field.parse(answer);
    if (value === null) return [];
    const onFile = field.fromProfile(profile);
    if (onFile !== null && field.parse(onFile) === value && field.readFrom(profile).every((leaf) => !leaf || leaf.source === "person")) return [];
    const fields = field.toProfile(value, profile);
    return Object.keys(fields).length > 0 ? [{ field: field.name, fields }] : [];
  });
}
