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

// What a person can tell Mano that settles which of a program's limits
// applies to them.
export type HouseholdFact = "earnedIncome" | "elderlyOrDisabled" | "dependentCare";
export type Condition = Partial<Record<HouseholdFact, boolean>>;

// One published income table and the households it applies to.
export interface LimitTable {
  appliesTo: string;
  // Alternatives: the table applies when any one of them holds. Absent means
  // nothing a person says settles it (for example categorical eligibility),
  // so the table always stays possible.
  when?: Condition[];
  // Dollars for household sizes 1, 2, 3, ... in order, every row the source
  // publishes; null where the source prints no limit for that size. Empty
  // when the source names this group but gives no amounts.
  bySize: (number | null)[];
  // Dollars added for each person past the last published row, only when the
  // source gives that increment.
  eachAdditional: number | null;
  // When this table is on a different official page than the rest of the fact.
  source?: Omit<Fact<never>, "value">;
}

export interface IncomeLimit {
  // The year the numbers are for, as the source labels it.
  year: string;
  // Which rule sets the limits.
  basis: string;
  period: "monthly" | "annual";
  // The income the limit is compared with: gross income before deductions,
  // net income after them, MAGI (modified adjusted gross income, with any
  // disregard), or not stated by the source.
  measuredOn: "gross" | "net" | "magi" | "unstated";
  tables: LimitTable[];
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

// A part of the state where people apply or renew another way (New York
// City through ACCESS HRA). Its facts replace the statewide ones there.
export interface AreaRoute {
  area: string;
  // Lowercase names a person may give for a place in the area: the city,
  // boroughs, counties.
  places: string[];
  facts: Partial<Pick<ProgramFacts, "apply" | "renewal" | "phone" | "website">>;
}

export type ProgramEntry = {
  state: StateCode;
  program: ProgramId;
  gaps: Gap[];
  areas?: AreaRoute[];
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
