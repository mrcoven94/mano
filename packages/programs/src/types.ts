export const STATES = ["CA", "TX", "NY", "FL", "IL", "WA", "AZ", "OH"] as const;
export type StateCode = (typeof STATES)[number];

export const PROGRAMS = ["snap", "medicaid", "liheap"] as const;
export type ProgramId = (typeof PROGRAMS)[number];

// One checked fact. The quote is the text on the source page that shows the
// value; verify-sources fetches the page again and looks for it.
export interface Fact<T> {
  value: T;
  sourceUrl: string;
  // YYYY-MM-DD, the day the source was read.
  checkedAt: string;
  quote: string;
}

export interface IncomeLimit {
  // The year the numbers are for, as the source labels it.
  year: string;
  // Who the limit applies to and which rule sets it.
  basis: string;
  period: "monthly" | "annual";
  // Dollars for household sizes 1, 2, 3, ... in order.
  bySize: number[];
  // Dollars added for each person past the last size, when the source gives one.
  eachAdditional: number | null;
}

export interface ProgramFacts {
  // The state's own name for the program (CalFresh, Medi-Cal, CEAP).
  name: Fact<string>;
  agency: Fact<string>;
  covers: Fact<string>;
  // Gross income limit.
  incomeLimit: Fact<IncomeLimit>;
  // SNAP only.
  netIncomeLimit: Fact<IncomeLimit>;
  renewal: Fact<string>;
  apply: Fact<string>;
  phone: Fact<string>;
  website: Fact<string>;
}

export type FactField = keyof ProgramFacts;

// What could not be confirmed, and why. A field missing from an entry is
// always named here; a gap on a present field is a caveat on its value.
export interface Gap {
  field: string;
  reason: string;
}

export type ProgramEntry = {
  state: StateCode;
  program: ProgramId;
  gaps: Gap[];
} & Partial<ProgramFacts>;

// A program site that is not on .gov, counted as official because a .gov
// page names or links it. Subdomains of the host count too.
export interface DocumentedSite {
  host: string;
  sourceUrl: string;
  checkedAt: string;
  quote: string;
}

export interface StateCatalog {
  state: StateCode;
  programs: Record<ProgramId, ProgramEntry>;
  documentedSites: DocumentedSite[];
}
