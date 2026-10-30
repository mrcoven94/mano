import type { Condition, HouseholdFact, LimitTable, ProgramEntry } from "./types.js";

export interface Household {
  householdSize: number;
  // Gross monthly income, before taxes and deductions, as the person said it.
  monthlyIncome: number;
  earnedIncome?: boolean;
  elderlyOrDisabled?: boolean;
  dependentCare?: boolean;
}

// A rough screen has two outcomes. It never tells a person they are past a
// limit: other rules, deductions and groups the catalog does not encode can
// still let them in, and a wrong "no" stops someone applying for help they
// would get.
export interface Screen {
  result: "may_qualify" | "cant_tell";
  limit?: { amount: number; period: "monthly" | "annual"; householdSize: number; year: string; appliesTo: string };
  sourceUrl?: string;
  checkedAt?: string;
  // What Mano may say about it.
  note: string;
}

// The published row for this size, or the last row plus the published
// increment for each person past it. Null when the source gives neither.
export function limitAt(table: Pick<LimitTable, "bySize" | "eachAdditional">, size: number): number | null {
  const last = table.bySize.length;
  if (size < 1 || last === 0) return null;
  if (size <= last) return table.bySize[size - 1] ?? null;
  const end = table.bySize[last - 1];
  return end == null || table.eachAdditional === null ? null : end + (size - last) * table.eachAdditional;
}

// A table stays possible unless what the person said rules out every one of
// its alternatives.
function possible(table: LimitTable, household: Household): boolean {
  if (!table.when) return true;
  const fits = (c: Condition) => (Object.entries(c) as [HouseholdFact, boolean][]).every(([k, v]) => household[k] === undefined || household[k] === v);
  return table.when.some(fits);
}

const HOW = "Say how to check with the office and offer to help them apply.";

function cantTell(name: string, why: string): Screen {
  return { result: "cant_tell", note: `This rough screen can't tell for ${name}: ${why}. Do not guess at the result. ${HOW}` };
}

// Compares the person's gross monthly income with every income table that
// could apply to their household, and says they may qualify only when it is
// at or under all of them. Anything else (a limit on MAGI or net income, a
// table with no amounts, a size with no published limit, an income the
// tables do not settle) is "can't tell".
export function screenIncome(entry: ProgramEntry, household: Household): Screen {
  const name = entry.name?.value ?? entry.program;
  const fact = entry.incomeLimit;
  const size = Math.floor(household.householdSize);
  if (!fact) return cantTell(name, "there is no confirmed income limit");
  if (size < 1) return cantTell(name, "it needs the household size");
  const { measuredOn, period, year, tables } = fact.value;
  if (measuredOn !== "gross") return cantTell(name, `this limit is measured on ${measuredOn === "magi" ? "MAGI income" : measuredOn === "net" ? "income after deductions" : "income the source does not define"}, which monthly pay alone does not show`);
  const candidates = tables.filter((t) => possible(t, household)).map((t) => ({ table: t, amount: limitAt(t, size) }));
  if (candidates.length === 0 || candidates.some((c) => c.amount === null)) return cantTell(name, "which limit applies, or its amount for this household size, depends on facts Mano does not have");
  const lowest = candidates.reduce((a, b) => (b.amount! < a.amount! ? b : a));
  const income = period === "annual" ? household.monthlyIncome * 12 : household.monthlyIncome;
  if (income > lowest.amount!) return cantTell(name, "their income alone does not settle it, since deductions and household rules decide");
  const source = lowest.table.source ?? fact;
  return {
    result: "may_qualify",
    limit: { amount: lowest.amount!, period, householdSize: size, year, appliesTo: lowest.table.appliesTo },
    sourceUrl: source.sourceUrl,
    checkedAt: source.checkedAt,
    note: `By what they told you, their income is at or under the ${name} gross limit for a household of ${size}, so they may qualify. This is a rough screen, not a decision: the agency decides. ${HOW}`,
  };
}
