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

const MEASURES = new Set(["gross", "net", "magi", "unstated"]);
const HOUSEHOLD_FACTS = new Set(["earnedIncome", "elderlyOrDisabled", "dependentCare"]);

function limitProblems(where: string, v: IncomeLimit, catalog: StateCatalog, today: string): string[] {
  const out: string[] = [];
  if (!v.year.trim()) out.push(`${where}: no year`);
  if (!v.basis.trim()) out.push(`${where}: no basis`);
  if (!MEASURES.has(v.measuredOn)) out.push(`${where}: measuredOn must say what income the limit is compared with`);
  if (v.tables.length === 0) out.push(`${where}: no tables`);
  for (const [i, t] of v.tables.entries()) {
    const at = `${where} table ${i + 1}`;
    if (!t.appliesTo.trim()) out.push(`${at}: no appliesTo`);
    const rows = t.bySize.filter((n): n is number => n !== null);
    if (rows.some((n, j) => !(n > 0) || (j > 0 && n < rows[j - 1]!))) out.push(`${at}: amounts must be positive and grow with household size`);
    if (t.eachAdditional !== null && !(t.eachAdditional > 0)) out.push(`${at}: eachAdditional must be positive or null`);
    if (t.bySize.length === 0 && t.eachAdditional !== null) out.push(`${at}: an add-on needs published rows`);
    for (const c of t.when ?? []) for (const k of Object.keys(c)) if (!HOUSEHOLD_FACTS.has(k)) out.push(`${at}: unknown household fact ${k}`);
    if (t.when && t.when.length === 0) out.push(`${at}: an empty when matches no household; omit it instead`);
    if (t.source) out.push(...sourceProblems(at, t.source, catalog, today));
  }
  return out;
}

function sourceProblems(where: string, s: { sourceUrl: string; checkedAt: string; quote: string }, catalog: StateCatalog, today: string): string[] {
  const out: string[] = [];
  if (!s.sourceUrl) out.push(`${where}: no source`);
  else if (!isOfficialUrl(s.sourceUrl, catalog)) out.push(`${where}: source ${s.sourceUrl} is not https on a .gov host or a documented state site`);
  if (!s.checkedAt) out.push(`${where}: no checked date`);
  else if (!realDate(s.checkedAt, today)) out.push(`${where}: checked date ${s.checkedAt} is not a real past date (YYYY-MM-DD)`);
  if (!s.quote || s.quote.trim().length < 10) out.push(`${where}: no quote from the source`);
  return out;
}

function factProblems(where: string, field: FactField, fact: Fact<unknown>, catalog: StateCatalog, today: string): string[] {
  const limit = field === "incomeLimit" || field === "netIncomeLimit";
  const out = sourceProblems(where, fact, catalog, today);
  if (!limit && strings(fact.value).every((s) => !s.trim())) out.push(`${where}: empty value`);
  if (field === "phone" && !PHONE_RE.test(String(fact.value).trim())) out.push(`${where}: ${String(fact.value)} is not one US phone number`);
  if (field === "website" && !isOfficialUrl(String(fact.value), catalog)) out.push(`${where}: ${String(fact.value)} is not https on a .gov host or a documented state site`);
  if (limit) out.push(...limitProblems(where, fact.value as IncomeLimit, catalog, today));
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
  for (const route of entry.areas ?? []) {
    if (route.places.length === 0 || route.places.some((p) => p !== p.toLowerCase())) out.push(`${at} ${route.area}: places must be lowercase names`);
    for (const [field, fact] of Object.entries(route.facts) as [FactField, Fact<unknown>][]) out.push(...factProblems(`${at} ${route.area} ${field}`, field, fact, catalog, today));
  }
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
