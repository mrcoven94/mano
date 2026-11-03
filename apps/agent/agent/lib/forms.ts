// The forms Mano knows how to fill, as a table: each form names its
// fields in the form's own words, where each value comes from in the
// profile, the one question to ask when it is missing, and how a value
// is checked. Only forms on our own sandbox portal are listed (hard rule
// 2): a resident's real portal is never a target.
//
// Text goes on a form exactly as the person or their letter gave it, less
// any spaces around it; a date or an amount is only written the way the
// form's field stores it. Nothing is invented, defaulted, shortened or
// changed to fit: a value that is missing, or does not fit its field,
// becomes one plain question, asked in the form's order of importance.
import type { Frequency, Profile } from "./engine.js";
import { confirmedByPerson } from "./profile.js";

export interface FormField {
  // The form's own input name, which the filing carries.
  name: string;
  // The label the form shows, used in the exact version the person approves.
  label: string;
  question: string;
  // The value as the profile holds it. It is checked like any answer.
  fromProfile(profile: Profile): string | null;
  // The checked value, or null when the answer does not fit the field.
  parse(answer: string): string | null;
}

export interface FormSpec {
  id: string;
  // The form's address on the sandbox portal.
  path: string;
  recipient: string;
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

// One line of text, kept exactly as given inside the spaces around it.
function trimmed(max: number) {
  return (answer: string) => {
    const v = answer.trim();
    return v && v.length <= max && !/[\r\n]/.test(v) ? v : null;
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
  const v = answer.trim();
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

// Unknown unless every entry has an amount and how often it comes: a
// total that left one out would understate the household's income.
function monthlyIncome(profile: Profile): string | null {
  if (profile.income.length === 0) return null;
  let total = 0;
  for (const i of profile.income) {
    if (!i.amount || !i.frequency) return null;
    total += i.amount.value * PER_MONTH[i.frequency.value];
  }
  return String(Math.round(total));
}

function mailingAddress(profile: Profile): string | null {
  const a = profile.person.address;
  if (!a?.line1 || !a.city || !a.state || !a.zip) return null;
  return [a.line1.value, a.line2?.value, a.city.value, `${a.state.value} ${a.zip.value}`].filter(Boolean).join(", ");
}

// The case number of the person's one food benefits case. Two different
// numbers are not chosen between; the person is asked.
const FOOD_PROGRAM = /\b(snap|calfresh|food)\b/i;
function foodCaseNumber(profile: Profile): string | null {
  const numbers = new Set(
    profile.programs.flatMap((p) => (p.program && FOOD_PROGRAM.test(p.program.value) && p.caseNumber ? [p.caseNumber.value] : [])),
  );
  return numbers.size === 1 ? [...numbers][0]! : null;
}

// The pay stub or other document an income amount was read from.
function incomeDocument(profile: Profile): string | null {
  return profile.income.find((i) => i.amount?.source === "document" && i.amount.documentId)?.amount?.documentId ?? null;
}

const FOOD_RENEWAL: FormSpec = {
  id: "food-renewal",
  path: "/apply",
  recipient: "sandbox-agency-portal",
  purpose: "Food benefits renewal in the sandbox agency portal",
  fields: [
    // Which case this is and whose: the office cannot match a renewal without them.
    {
      name: "caseNumber",
      label: "Case number",
      question: "What is the case number on your renewal letter?",
      fromProfile: foodCaseNumber,
      parse: trimmed(40),
    },
    {
      name: "fullName",
      label: "Full legal name",
      question: "What is your full legal name, as it appears on your benefits letters?",
      fromProfile: (p) => p.person.fullName?.value ?? null,
      parse: trimmed(200),
    },
    {
      name: "dateOfBirth",
      label: "Date of birth",
      question: "What is your date of birth?",
      fromProfile: (p) => p.person.dateOfBirth?.value ?? null,
      parse: isoDate,
    },
    // What the benefit is decided on.
    {
      name: "householdSize",
      label: "People in household",
      question: "How many people live in your household, counting you?",
      // Only the person's own confirmation says the list is everyone: one
      // child mentioned in passing is not a household, and a confirmed
      // empty list means they live alone.
      fromProfile: (p) => (confirmedByPerson(p) ? String(p.household.length + 1) : null),
      parse: wholeNumber(1, 30),
    },
    {
      name: "monthlyIncome",
      label: "Monthly income ($)",
      question: "About how much does your household earn in a month, before taxes?",
      fromProfile: monthlyIncome,
      parse: dollars,
    },
    // How the office reaches her.
    {
      name: "address",
      label: "Mailing address",
      question: "What is your mailing address, with city, state and ZIP?",
      fromProfile: mailingAddress,
      parse: trimmed(300),
    },
    {
      name: "phone",
      label: "Phone number",
      question: "What phone number should the office use to reach you?",
      fromProfile: (p) => p.person.phone?.value ?? null,
      parse: phone,
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
