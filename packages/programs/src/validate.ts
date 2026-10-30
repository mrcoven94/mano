import type { Fact, FactField, IncomeLimit, ProgramEntry, ProgramId, StateCatalog, StateCode } from "./types.js";
import { PROGRAMS, STATES } from "./types.js";

const FIELDS: FactField[] = ["name", "agency", "covers", "incomeLimit", "netIncomeLimit", "renewal", "apply", "phone", "website"];

export const REQUIRED_FIELDS: Record<ProgramId, FactField[]> = {
  snap: FIELDS,
  medicaid: FIELDS.filter((f) => f !== "netIncomeLimit"),
  liheap: FIELDS.filter((f) => f !== "netIncomeLimit"),
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^(?:1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function onHost(host: string, site: string): boolean {
  const s = site.toLowerCase().replace(/^www\./, "");
  return host === s || host.endsWith(`.${s}`);
}

// An official host: any .gov host, or a site a .gov page documents as the
// state's own program site (and its subdomains).
export function isOfficialUrl(url: string, catalog: Pick<StateCatalog, "documentedSites">): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return host.endsWith(".gov") || catalog.documentedSites.some((d) => onHost(host, d.host));
}

function realDate(s: string, today: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s <= today;
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

function limitProblems(where: string, v: IncomeLimit): string[] {
  const out: string[] = [];
  if (!v.year.trim()) out.push(`${where}: no year`);
  if (!v.basis.trim()) out.push(`${where}: no basis`);
  if (v.bySize.length === 0) out.push(`${where}: no household sizes`);
  if (v.bySize.some((n, i) => !(n > 0) || (i > 0 && n < v.bySize[i - 1]!))) out.push(`${where}: amounts must be positive and grow with household size`);
  if (v.eachAdditional !== null && !(v.eachAdditional > 0)) out.push(`${where}: eachAdditional must be positive or null`);
  return out;
}

function factProblems(where: string, field: FactField, fact: Fact<unknown>, catalog: StateCatalog, today: string): string[] {
  const out: string[] = [];
  if (strings(fact.value).every((s) => !s.trim()) && field !== "incomeLimit" && field !== "netIncomeLimit") out.push(`${where}: empty value`);
  if (!fact.sourceUrl) out.push(`${where}: no source`);
  else if (!isOfficialUrl(fact.sourceUrl, catalog)) out.push(`${where}: source ${fact.sourceUrl} is not https on a .gov host or a documented state site`);
  if (!fact.checkedAt) out.push(`${where}: no checked date`);
  else if (!realDate(fact.checkedAt, today)) out.push(`${where}: checked date ${fact.checkedAt} is not a real past date (YYYY-MM-DD)`);
  if (!fact.quote || fact.quote.trim().length < 10) out.push(`${where}: no quote from the source`);
  if (field === "phone" && !PHONE_RE.test(String(fact.value).trim())) out.push(`${where}: ${String(fact.value)} is not one US phone number`);
  if (field === "website" && !isOfficialUrl(String(fact.value), catalog)) out.push(`${where}: ${String(fact.value)} is not https on a .gov host or a documented state site`);
  if (field === "incomeLimit" || field === "netIncomeLimit") out.push(...limitProblems(where, fact.value as IncomeLimit));
  return out;
}

function entryProblems(state: StateCode, program: ProgramId, entry: ProgramEntry, catalog: StateCatalog, today: string): string[] {
  const at = `${state} ${program}`;
  const out: string[] = [];
  if (entry.state !== state || entry.program !== program) out.push(`${at}: entry says ${entry.state} ${entry.program}`);
  for (const field of FIELDS) {
    const fact = entry[field] as Fact<unknown> | undefined;
    if (fact) out.push(...factProblems(`${at} ${field}`, field, fact, catalog, today));
  }
  for (const field of REQUIRED_FIELDS[program]) {
    const named = entry.gaps.some((g) => g.field === field || g.field.startsWith(`${field}.`) || g.field.startsWith(`${field} `));
    if (!entry[field] && !named) out.push(`${at} ${field}: missing and not named in gaps`);
  }
  for (const g of entry.gaps) if (!g.reason.trim()) out.push(`${at} gap ${g.field}: no reason`);
  return out;
}

// Every problem with the catalog, as one line each. Empty means it passes:
// every fact has a source on an official host, a real checked date and a
// quote; every phone is one number and every site is official; every field
// the program needs is present or named, with a reason, in its gaps.
export function validateCatalog(catalogs: Record<StateCode, StateCatalog>, today = new Date().toISOString().slice(0, 10)): string[] {
  const out: string[] = [];
  for (const state of STATES) {
    const catalog = catalogs[state];
    if (!catalog) {
      out.push(`${state}: no catalog`);
      continue;
    }
    for (const d of catalog.documentedSites) {
      const host = hostOf(d.sourceUrl);
      if (!host || !host.endsWith(".gov")) out.push(`${state} site ${d.host}: documented by ${d.sourceUrl}, which is not https on a .gov host`);
      if (!realDate(d.checkedAt, today)) out.push(`${state} site ${d.host}: checked date ${d.checkedAt} is not a real past date`);
      if (!d.quote || d.quote.trim().length < 10) out.push(`${state} site ${d.host}: no quote`);
    }
    for (const program of PROGRAMS) {
      const entry = catalog.programs[program];
      if (!entry) out.push(`${state} ${program}: no entry`);
      else out.push(...entryProblems(state, program, entry, catalog, today));
    }
    for (const s of strings(catalog)) if (s.includes("—")) out.push(`${state}: em dash in ${JSON.stringify(s.slice(0, 60))}`);
  }
  return out;
}
