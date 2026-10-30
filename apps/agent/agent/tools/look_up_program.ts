// Checked program facts from @mano/programs: the only place the agent gets
// a program's name, limits, renewal cycle, phone or site. Each fact comes
// with its official source and the day it was checked; what was not
// confirmed comes back as notConfirmed, so the agent says so.
import { CATALOG_VERSION, listPrograms, lookupProgram, screenIncome, type Fact, type ProgramEntry, type ProgramId, type Screen } from "@mano/programs";
import { defineTool } from "eve/tools";
import { z } from "zod";

const FEDERAL_NAME: Record<ProgramId, string> = { snap: "SNAP", medicaid: "Medicaid", liheap: "LIHEAP" };

const inputSchema = z.object({
  state: z.string().min(2).max(40),
  program: z.string().min(2).max(80).optional(),
  householdSize: z.number().int().min(1).max(30).optional(),
  monthlyIncome: z.number().min(0).max(1_000_000).optional(),
});

type Shown = { value: unknown; source: string; checked: string };
const shown = ({ value, sourceUrl, checkedAt }: Fact<unknown>): Shown => ({ value, source: sourceUrl, checked: checkedAt });

const FIELDS = ["covers", "incomeLimit", "netIncomeLimit", "renewal", "apply", "phone", "website", "agency"] as const;

function present(entry: ProgramEntry, household: { householdSize?: number; monthlyIncome?: number }) {
  const facts: Record<string, Shown> = {};
  if (entry.name) facts.name = shown(entry.name);
  for (const f of FIELDS) {
    const fact = entry[f] as Fact<unknown> | undefined;
    if (fact) facts[f] = shown(fact);
  }
  const screen: Screen | undefined =
    household.householdSize !== undefined && household.monthlyIncome !== undefined
      ? screenIncome(entry, { householdSize: household.householdSize, monthlyIncome: household.monthlyIncome })
      : undefined;
  return {
    federalName: FEDERAL_NAME[entry.program],
    name: entry.name?.value ?? FEDERAL_NAME[entry.program],
    facts,
    notConfirmed: entry.gaps,
    ...(screen ? { screen } : {}),
  };
}

export default defineTool({
  description:
    "Look up checked facts about SNAP, Medicaid and LIHEAP in California, Texas, New York, Florida, Illinois, Washington, Arizona and Ohio: the state's own program name, what it covers, gross (and for SNAP net) income limits by household size with the year they are for, the renewal cycle, how to apply or renew, and the official phone and site. Give the state; give a program (any name, such as CalFresh or food stamps) for one program, or leave it out for all three. Give householdSize and monthlyIncome only when the person told you both: the result then has a rough screen against the gross limit. Use only the facts the question needs, never a whole table. Say a fact only if it is in facts; anything in notConfirmed, or not returned, you do not know. A screen is never a decision: say they may qualify and why, and how to check, never that they qualify.",
  inputSchema,
  label: {
    start: () => "Look up the program",
  },
  async execute(input) {
    const entries = input.program ? [lookupProgram({ state: input.state, program: input.program })].filter((e) => e !== null) : listPrograms(input.state);
    if (entries.length === 0) {
      return {
        found: false as const,
        note: `Mano has no checked facts for ${input.program ?? "programs"} in ${input.state}. Say you do not know and offer to check, without guessing a name, limit, phone or site.`,
      };
    }
    return { found: true as const, catalogVersion: CATALOG_VERSION, programs: entries.map((e) => present(e, input)) };
  },
});
