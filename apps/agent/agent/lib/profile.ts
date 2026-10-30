// The person's profile: the one structured record of who they are, where
// they live, their household, income and programs, kept by Engine (GET and
// PATCH /profile). Every form and answer draws from it, so the person never
// says the same thing twice. This file turns the update tool's input into
// Engine field paths, renders the profile for the model at the start of a
// turn, and writes the plain summary the person gets when they ask what
// Mano has on them.
import { createHash } from "node:crypto";

import type { Frequency, Leaf, Profile } from "./engine.js";

type Value = string | number;

export interface ProfileInput {
  person?: {
    fullName?: string;
    dateOfBirth?: string;
    phone?: string;
    email?: string;
    address?: { line1?: string; line2?: string; city?: string; state?: string; zip?: string };
    county?: string;
    language?: string;
  };
  household?: { ref?: string; name?: string; relationship?: string; dateOfBirth?: string }[];
  income?: { ref?: string; member?: string; source?: string; amount?: number; frequency?: Frequency }[];
  programs?: { ref?: string; program?: string; state?: string; caseNumber?: string; status?: string }[];
  forget?: string[];
}

// A change the model asked for that cannot be applied as given. The
// message goes back to the model.
export class ProfileInputProblem extends Error {
  override name = "ProfileInputProblem";
}

const PERSON_LABELS: Record<string, string> = {
  "person.fullName": "name",
  "person.dateOfBirth": "date of birth",
  "person.phone": "phone",
  "person.email": "email",
  "person.address.line1": "address",
  "person.address.line2": "address",
  "person.address.city": "address",
  "person.address.state": "address",
  "person.address.zip": "address",
  "person.county": "county",
  "person.language": "language",
};

// Plain names the model may pass to forget, and the path each clears.
const FORGET_TARGETS: Record<string, string> = {
  name: "person.fullName",
  "date of birth": "person.dateOfBirth",
  phone: "person.phone",
  email: "person.email",
  address: "person.address",
  county: "person.county",
  language: "person.language",
  household: "household",
  income: "income",
  programs: "programs",
};
export const FORGET_NAMES = Object.keys(FORGET_TARGETS);

const same = (a: string | undefined, b: string | undefined) =>
  (a ?? "").trim().toLowerCase().replace(/\s+/g, " ") === (b ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function newRef(turnId: string, collection: string, index: number, key: string): string {
  return `${collection.slice(0, 1)}${createHash("sha256").update(`${turnId}\n${collection}\n${index}\n${key}`).digest("hex").slice(0, 10)}`;
}

function refIn(entries: { id: string }[], ref: string | undefined, collection: string): string | undefined {
  if (!ref) return undefined;
  if (!entries.some((e) => e.id === ref)) throw new ProfileInputProblem(`There is no ${collection} entry ${ref} on file.`);
  return ref;
}

export interface ProfileChanges {
  fields: Record<string, Value | null>;
  labels: Record<string, string>;
}

// The tool's input as Engine field paths. Entries without a ref join the
// one already on file with the same name (household), program or member
// and source (income); otherwise they get a new ref derived from the turn,
// so a retried turn writes the same entry, not a second one.
export function profileChanges(input: ProfileInput, current: Profile, turnId: string): ProfileChanges {
  const fields: Record<string, Value | null> = {};
  const labels: Record<string, string> = {};
  const set = (path: string, value: Value | undefined, label: string) => {
    if (value === undefined || value === "") return;
    fields[path] = value;
    labels[path] = label;
  };

  for (const name of input.forget ?? []) {
    const key = name.trim().toLowerCase();
    const path =
      FORGET_TARGETS[key] ??
      (["household", "income", "programs"] as const)
        .flatMap((c) => current[c].filter((e) => e.id === name.trim()).map((e) => `${c}.${e.id}`))
        .at(0);
    if (!path) throw new ProfileInputProblem(`"${name}" is not something on file. Use one of: ${FORGET_NAMES.join(", ")}, or an entry's ref.`);
    fields[path] = null;
    labels[path] = key in FORGET_TARGETS ? key : "that entry";
  }

  const p = input.person ?? {};
  for (const [key, value] of Object.entries(p)) {
    if (key === "address") continue;
    set(`person.${key}`, value as string | undefined, PERSON_LABELS[`person.${key}`] ?? key);
  }
  for (const [key, value] of Object.entries(p.address ?? {})) set(`person.address.${key}`, value, "address");

  const members = new Map<string, string>();
  for (const m of current.household) if (m.name) members.set(m.name.value.toLowerCase(), m.id);
  (input.household ?? []).forEach((m, i) => {
    const byRef = refIn(current.household, m.ref, "household");
    const byName = byRef ? undefined : current.household.find((e) => m.name && same(e.name?.value, m.name));
    const id = byRef ?? byName?.id ?? newRef(turnId, "household", i, m.name ?? "");
    const who = byName?.name?.value ?? m.name ?? current.household.find((e) => e.id === id)?.name?.value ?? "household member";
    if (m.name) members.set(m.name.toLowerCase(), id);
    // Found by the same name: the name on file stays as it was written.
    if (!byName) set(`household.${id}.name`, m.name, who);
    set(`household.${id}.relationship`, m.relationship, `${who}'s relationship`);
    set(`household.${id}.dateOfBirth`, m.dateOfBirth, `${who}'s date of birth`);
  });

  (input.income ?? []).forEach((inc, i) => {
    let memberId: string | undefined;
    if (inc.member) {
      memberId = /^(self|me|myself)$/i.test(inc.member.trim()) ? "self" : members.get(inc.member.trim().toLowerCase());
      if (!memberId) throw new ProfileInputProblem(`${inc.member} is not in the household on file. Add them to household in the same call first.`);
    }
    const id =
      refIn(current.income, inc.ref, "income") ??
      current.income.find((e) => (memberId ?? "self") === (e.memberId?.value ?? "self") && same(e.source?.value, inc.source))?.id ??
      newRef(turnId, "income", i, `${memberId ?? ""}\n${inc.source ?? ""}`);
    set(`income.${id}.memberId`, memberId, "income");
    set(`income.${id}.source`, inc.source, "income");
    set(`income.${id}.amount`, inc.amount, "income");
    set(`income.${id}.frequency`, inc.frequency, "income");
  });

  (input.programs ?? []).forEach((prog, i) => {
    const id =
      refIn(current.programs, prog.ref, "programs") ??
      current.programs.find((e) => prog.program && same(e.program?.value, prog.program) && (!prog.state || same(e.state?.value, prog.state)))?.id ??
      newRef(turnId, "programs", i, `${prog.program ?? ""}\n${prog.state ?? ""}`);
    const name = prog.program ?? current.programs.find((e) => e.id === id)?.program?.value ?? "program";
    set(`programs.${id}.program`, prog.program, name);
    set(`programs.${id}.state`, prog.state, `${name} state`);
    set(`programs.${id}.caseNumber`, prog.caseNumber, `${name} case number`);
    set(`programs.${id}.status`, prog.status, `${name} status`);
  });

  return { fields, labels };
}

// One key per turn and exact change: a retried turn converges on the
// first write; a different change in the same turn is its own write.
export function profileKey(turnId: string, fields: Record<string, Value | null>): string {
  const canonical = JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  return `profile-${createHash("sha256").update(`${turnId}\n${canonical}`).digest("hex").slice(0, 40)}`;
}

const PER: Record<Frequency, string> = { weekly: "a week", biweekly: "every two weeks", monthly: "a month", yearly: "a year" };

function money(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function addressOf(profile: Profile): string | null {
  const a = profile.person.address;
  const street = [a.line1?.value, a.line2?.value].filter(Boolean).join(" ");
  const cityLine = [a.city?.value, [a.state?.value, a.zip?.value].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const text = [street, cityLine].filter(Boolean).join(", ");
  return text || null;
}

// selfName: how to name the person as an earner, or null to name no one.
function incomeText(profile: Profile, inc: Profile["income"][number], selfName: string | null): string {
  const amount = inc.amount ? `${money(inc.amount.value)}${inc.frequency ? ` ${PER[inc.frequency.value]}` : ""}` : "amount not on file";
  const memberId = inc.memberId?.value ?? "self";
  const owner =
    selfName === null ? null : memberId === "self" ? selfName : (profile.household.find((m) => m.id === memberId)?.name?.value ?? "a household member");
  return `${inc.source?.value ? `${inc.source.value}, ` : ""}${amount}${owner ? ` (${owner})` : ""}`;
}

function provenance(leaf: Leaf<unknown> | undefined): string {
  if (leaf?.source === "document") return " (read from their document)";
  if (leaf?.source === "agent") return " (from earlier notes; confirm before relying on it)";
  return "";
}

const PERSON_LINES: [string, (p: Profile) => { text: string | null; leaf?: Leaf<unknown> }][] = [
  ["Name", (p) => ({ text: p.person.fullName?.value ?? null, leaf: p.person.fullName })],
  ["Date of birth", (p) => ({ text: p.person.dateOfBirth?.value ?? null, leaf: p.person.dateOfBirth })],
  ["Phone", (p) => ({ text: p.person.phone?.value ?? null, leaf: p.person.phone })],
  ["Email", (p) => ({ text: p.person.email?.value ?? null, leaf: p.person.email })],
  ["Address", (p) => ({ text: addressOf(p), leaf: p.person.address.line1 ?? p.person.address.city })],
  ["County", (p) => ({ text: p.person.county?.value ?? null, leaf: p.person.county })],
  ["Language", (p) => ({ text: p.person.language?.value ?? null, leaf: p.person.language })],
];

function isEmpty(profile: Profile): boolean {
  return PERSON_LINES.every(([, get]) => !get(profile).text) && !profile.household.length && !profile.income.length && !profile.programs.length;
}

// What the model sees at the start of each turn. Refs in brackets let it
// update an entry; they are never shown to the person. Empty renders
// nothing, so a new person pays no context for it.
export function renderProfile(profile: Profile): string | null {
  if (isEmpty(profile)) return null;
  const lines = ["The person's profile on file. Use it for forms and answers and never ask for any of it again:"];
  const missing: string[] = [];
  for (const [label, get] of PERSON_LINES) {
    const { text, leaf } = get(profile);
    if (text) lines.push(`- ${label}: ${text}${provenance(leaf)}`);
    else missing.push(label.toLowerCase());
  }
  for (const m of profile.household) {
    const parts = [m.name?.value ?? "unnamed", m.relationship?.value, m.dateOfBirth ? `born ${m.dateOfBirth.value}` : null].filter(Boolean);
    lines.push(`- Household member: ${parts.join(", ")}${provenance(m.name)} [${m.id}]`);
  }
  for (const inc of profile.income) lines.push(`- Income: ${incomeText(profile, inc, "the person")}${provenance(inc.amount)} [${inc.id}]`);
  for (const prog of profile.programs) {
    const parts = [prog.program?.value ?? "program", prog.state?.value, prog.caseNumber ? `case ${prog.caseNumber.value}` : null, prog.status?.value].filter(Boolean);
    lines.push(`- Program: ${parts.join(", ")}${provenance(prog.caseNumber ?? prog.program)} [${prog.id}]`);
  }
  lines.push(`- Household size on file: ${1 + profile.household.length} including the person`);
  if (missing.length) lines.push(`Not on file yet: ${missing.join(", ")}. Ask only for what a task needs, one question at a time.`);
  return lines.join("\n");
}

// The short, plain answer to "what do you have on me?".
export function summarizeProfile(profile: Profile): string {
  if (isEmpty(profile)) return "I don't have anything saved about you yet.";
  const sentences: string[] = [];
  const name = profile.person.fullName?.value;
  const dob = profile.person.dateOfBirth?.value;
  if (name || dob) sentences.push([name, dob ? `born ${dob}` : null].filter(Boolean).join(", "));
  const address = addressOf(profile);
  const county = profile.person.county?.value;
  if (address || county) sentences.push([address, county && address ? `(${county})` : county].filter(Boolean).join(" "));
  const contact = [profile.person.phone ? `phone ${profile.person.phone.value}` : null, profile.person.email ? `email ${profile.person.email.value}` : null].filter(Boolean);
  if (contact.length) sentences.push(contact.join(", "));
  if (profile.person.language) sentences.push(`prefers ${profile.person.language.value}`);
  if (profile.household.length) {
    sentences.push(
      `Household: ${profile.household.map((m) => [m.name?.value ?? "someone", m.relationship ? `(${m.relationship.value})` : null].filter(Boolean).join(" ")).join(", ")}`,
    );
  }
  if (profile.income.length) sentences.push(`Income: ${profile.income.map((inc) => incomeText(profile, inc, profile.household.length > 0 ? "you" : null)).join("; ")}`);
  if (profile.programs.length) {
    sentences.push(
      profile.programs.map((p) => [p.program?.value ?? "A program", p.caseNumber ? `case ${p.caseNumber.value}` : null, p.status?.value].filter(Boolean).join(" ")).join(", "),
    );
  }
  return `Here is what I have on you: ${sentences.join(". ")}.`;
}
