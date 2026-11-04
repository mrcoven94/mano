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

import { usAddressParts, usStateInAddress, type RecipientId } from "@mano/protocol";

import type { Frequency, Leaf, Profile } from "./engine.js";
import { ENDS_IN_ZIP, STATED_TOTAL, addressIsWhole, confirmedByPerson, householdSizeOf } from "./profile.js";

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
  // The value this field's own answer left, where fromProfile can also work
  // one out from other facts. A value worked out is not the person's answer,
  // and later facts can change it, so their answer is still saved.
  kept?(profile: Profile): string | null;
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
  // In the form's own order, which is the order Mano asks for them, most
  // important first, except asksFirst.
  fields: FormField[];
  // Asked before the rest because another field depends on it.
  asksFirst: string;
  // The profile as one call's answers leave it, where one field depends on
  // another.
  answered(profile: Profile, answers: Record<string, string>): Profile;
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

// The form asks for one household total, kept as its own entry and never
// added to the others, which it already counts. The person changing any
// other entry retires it (profileChanges), so it never comes back; a document
// or note ranks below their word and leaves it. Changed to anything but
// monthly, it is an entry like the others.
function incomeOnFile(profile: Profile): { stated: Leaf<number> | null; entries: Profile["income"] } {
  const own = profile.income.find((i) => i.id === STATED_TOTAL);
  if (own?.frequency?.value !== "monthly" || !own.amount) return { stated: null, entries: profile.income };
  return { stated: own.amount, entries: profile.income.filter((i) => i !== own) };
}

// The total the person gave. Otherwise unknown unless every
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

// What Engine keeps in one line of text.
const ADDRESS_LINE_MAX = 200;

// Her whole address stands as she gave it, whatever a document adds around
// it. A part she changed beside it leaves it unclear, so she is asked. A
// document's second line does not join an address that is her word.
function mailingAddress(profile: Profile): string | null {
  const a = profile.person.address;
  if (!a?.line1) return null;
  if (addressIsWhole(a)) return a.line1.value;
  if (!a.city || !a.state || !a.zip) return ENDS_IN_ZIP.test(a.line1.value) && a.city?.source !== "person" && a.zip?.source !== "person" ? a.line1.value : null;
  const line2 = a.line1.source !== "person" || a.line2?.source === "person" ? a.line2?.value : undefined;
  return [a.line1.value, line2, a.city.value, `${a.state.value} ${a.zip.value}`].filter(Boolean).join(", ");
}

// Split where a street, a city and a state can be told apart, and kept whole
// where they cannot. Nothing without a ZIP: part of an address must not
// replace a whole one.
function addressFields(value: string): ProfileFields {
  if (!ENDS_IN_ZIP.test(value) || value.length > ADDRESS_LINE_MAX) return {};
  const at = (part: string) => `person.address.${part}`;
  const found = usAddressParts(value);
  const pieces = found?.rest.split(/\s*,\s*/).filter(Boolean) ?? [];
  if (!found || pieces.length < 2) return { [at("line1")]: value, [at("line2")]: null, [at("city")]: null, [at("state")]: found?.state ?? null, [at("zip")]: null };
  return { [at("line1")]: pieces[0]!, [at("line2")]: pieces.slice(1, -1).join(", ") || null, [at("city")]: pieces.at(-1)!, [at("state")]: found.state, [at("zip")]: found.zip };
}

// The profile as this call's answers leave it, for the state the case
// number depends on. An address that names no state leaves the state unknown.
function withAnsweredState(profile: Profile, answers: Record<string, string>): Profile {
  const answer = Object.hasOwn(answers, "address") ? taken(answers.address!) : "";
  if (!answer) return profile;
  const { state: _onFile, ...address } = profile.person.address;
  const state = usStateInAddress(answer);
  return { ...profile, person: { ...profile.person, address: state ? { ...address, state: { value: state, source: "person", updatedAt: "" } } : address } };
}

const FOOD_PROGRAM = /\b(snap|calfresh|food)\b/i;

// The state the case number depends on. Her whole address that names no state
// leaves it unknown, whatever state a document fills in beside it.
function stateOnFile(profile: Profile): string | null {
  const a = profile.person.address;
  if (!a?.state || (addressIsWhole(a) && a.state.source !== "person")) return null;
  return a.state.value.toUpperCase();
}

// The person's food cases in the state on file. A case counts only for its
// own state, so a number never reaches another state's filing: with the
// state unknown, or a case with no state, the person is asked.
function foodCases(profile: Profile): Profile["programs"] {
  const state = stateOnFile(profile);
  if (!state) return [];
  return profile.programs.filter((p) => p.program && FOOD_PROGRAM.test(p.program.value) && p.state?.value.toUpperCase() === state);
}

// Two different numbers are not chosen between; the person is asked.
function foodCaseNumber(profile: Profile): string | null {
  const numbers = new Set(foodCases(profile).flatMap((p) => (p.caseNumber ? [p.caseNumber.value] : [])));
  return numbers.size === 1 ? [...numbers][0]! : null;
}

// The number goes on the one case for her state, or a case with no state,
// which it then belongs to, or a new one. Nothing is kept where that is not
// clear: the form still has the answer, and a later call asks.
function caseNumberFields(value: string, profile: Profile): ProfileFields {
  const state = stateOnFile(profile);
  if (!state) return {};
  const cases = foodCases(profile);
  if (cases.length > 1) return {};
  if (cases[0]) return { [`programs.${cases[0].id}.caseNumber`]: value };
  const stateless = profile.programs.filter((p) => p.program && FOOD_PROGRAM.test(p.program.value) && !p.state);
  if (stateless.length === 1) return { [`programs.${stateless[0]!.id}.caseNumber`]: value, [`programs.${stateless[0]!.id}.state`]: state };
  // A key no entry on file holds, since an entry's state can be corrected
  // after it is named. A retried turn finds its own entry among her cases.
  const taken = new Set(profile.programs.map((p) => p.id));
  let n = 1;
  while (taken.has(`food-${state.toLowerCase()}-${n}`)) n++;
  const id = `programs.food-${state.toLowerCase()}-${n}`;
  return { [`${id}.program`]: "Food benefits", [`${id}.state`]: state, [`${id}.caseNumber`]: value };
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
  answered: withAnsweredState,
  // A case number counts only for its own state.
  asksFirst: "address",
  fields: [
    // Which case this is and whose: the office cannot match a renewal without them.
    {
      name: "caseNumber",
      label: "Case number",
      question: "What is the case number on your renewal letter?",
      fromProfile: foodCaseNumber,
      readFrom: (p) => foodCases(p).map((c) => c.caseNumber),
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
      readFrom: (p) => [incomeOnFile(p).stated ?? undefined],
      kept: (p) => {
        const { stated } = incomeOnFile(p);
        return stated ? String(stated.value) : null;
      },
      parse: dollars,
      toProfile: (value) => ({
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
export function fillFrom(form: FormSpec, saved: Profile, answers: Record<string, string>): FilledForm {
  const profile = form.answered(saved, answers);
  const values: Record<string, string> = {};
  const invalid: FilledForm["invalid"] = [];
  let missing: FilledForm["missing"] = null;
  let first: FilledForm["missing"] = null;
  for (const field of form.fields) {
    const ask = { name: field.name, label: field.label, question: field.question };
    const answer = Object.hasOwn(answers, field.name) ? answers[field.name] : undefined;
    const fromAnswer = answer === undefined ? null : field.parse(answer);
    if (answer !== undefined && fromAnswer === null) invalid.push(ask);
    const onFile = fromAnswer === null ? field.fromProfile(profile) : null;
    const value = fromAnswer ?? (onFile === null ? null : field.parse(onFile));
    if (value === null) {
      const asking = onFile === null ? ask : { ...ask, question: `I have ${onFile.trim()} as your ${field.label.toLowerCase()}, but it does not fit the form. ${field.question}` };
      missing ??= asking;
      if (field.name === form.asksFirst) first = asking;
      continue;
    }
    values[field.name] = value;
  }
  missing = first ?? missing;
  const documentId = form.proof.fromProfile(profile);
  if (!documentId) missing ??= { name: "proof", label: form.proof.label, question: form.proof.question };
  return { values, documentId, missing, invalid };
}

// What the person's answers change on their profile, one entry per field:
// every checked answer, unless the profile already gives that value as
// their own word. One that only matches a document's value is still written,
// so it becomes theirs and a later document can only suggest a change.
export function answerChanges(form: FormSpec, saved: Profile, answers: Record<string, string>): { field: string; fields: ProfileFields }[] {
  const profile = form.answered(saved, answers);
  return form.fields.flatMap((field) => {
    const answer = Object.hasOwn(answers, field.name) ? answers[field.name] : undefined;
    const value = answer === undefined ? null : field.parse(answer);
    if (value === null) return [];
    // Fields that depend on the answered address are judged as it leaves
    // them; the address itself against what is saved, or a correction to
    // only its state would look like nothing changed.
    const before = field.name === form.asksFirst ? saved : profile;
    const onFile = (field.kept ?? field.fromProfile)(before);
    if (onFile !== null && field.parse(onFile) === value && field.readFrom(before).every((leaf) => !leaf || leaf.source === "person")) return [];
    const fields = field.toProfile(value, profile);
    return Object.keys(fields).length > 0 ? [{ field: field.name, fields }] : [];
  });
}
