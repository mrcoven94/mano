import type { ProgramEntry } from "./types.js";

export interface Screen {
  result: "under_limit" | "over_limit" | "unknown";
  limit?: { amount: number; period: "monthly" | "annual"; householdSize: number; year: string; basis: string };
  sourceUrl?: string;
  checkedAt?: string;
  // What Mano may say about it. Never a promise: only the agency decides.
  note: string;
}

// A rough income screen against the program's gross limit. It reads only
// the household size and monthly income the person gave, and it never
// decides eligibility: other rules (resources, immigration status, work
// rules, deductions) still apply.
export function screenIncome(entry: ProgramEntry, household: { householdSize: number; monthlyIncome: number }): Screen {
  const name = entry.name?.value ?? entry.program;
  const fact = entry.incomeLimit;
  const size = Math.floor(household.householdSize);
  if (!fact || size < 1) return { result: "unknown", note: `There is no confirmed ${name} income limit for this household size. Offer to check with the agency.` };
  const { bySize, eachAdditional, period, year, basis } = fact.value;
  const last = bySize.length;
  const amount = size <= last ? bySize[size - 1] : eachAdditional === null ? undefined : bySize[last - 1]! + (size - last) * eachAdditional;
  if (amount === undefined) return { result: "unknown", note: `There is no confirmed ${name} income limit for a household of ${size}. Offer to check with the agency.` };
  const income = period === "annual" ? household.monthlyIncome * 12 : household.monthlyIncome;
  const limit = { amount, period, householdSize: size, year, basis };
  const source = { sourceUrl: fact.sourceUrl, checkedAt: fact.checkedAt };
  if (income <= amount) {
    return {
      result: "under_limit",
      limit,
      ...source,
      note: `By what the person said, their income is at or under the ${name} gross limit for ${size}, so they may qualify. This is a rough screen, not a decision: the agency decides, and other rules still apply.`,
    };
  }
  return {
    result: "over_limit",
    limit,
    ...source,
    note: `By what the person said, their income is over the ${name} gross limit for ${size}. Some households still get help under other rules, and the agency decides, so offer to check rather than rule it out.`,
  };
}
