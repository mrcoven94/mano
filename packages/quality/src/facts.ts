// Fixture catalog the bench facts mirror. Program names are real public program
// names; every phone number uses the 555-01XX range reserved for fiction, every
// link uses .example domains, and every person is made up. Run with:
// node --test test/cases.test.ts

import type { CaseFacts } from "./suites/types.ts";

export interface FixtureProgram {
  name: string;
  phone: string;
  url: string;
  amount: string;
}

export interface FixtureState {
  code: string;
  name: string;
  spanishName: string;
  programs: FixtureProgram[];
  renewalDate: string;
  renewalDateEs: string;
}

const P = (name: string, phone: string, url: string, amount: string): FixtureProgram => ({ name, phone, url, amount });

export const FIXTURE_STATES: FixtureState[] = [
  {
    code: "CA", name: "California", spanishName: "California",
    programs: [
      P("SNAP", "(555) 010-1101", "https://www.ca-food-help.example/apply", "$292"),
      P("Medicaid", "(555) 010-1102", "https://www.ca-health-cover.example/renew", "$0"),
    ],
    renewalDate: "November 15, 2026", renewalDateEs: "15 de noviembre de 2026",
  },
  {
    code: "TX", name: "Texas", spanishName: "Texas",
    programs: [
      P("SNAP", "(555) 010-1201", "https://www.tx-food-help.example/apply", "$281"),
      P("LIHEAP", "(555) 010-1202", "https://www.tx-energy-aid.example/apply", "$450"),
    ],
    renewalDate: "November 20, 2026", renewalDateEs: "20 de noviembre de 2026",
  },
  {
    code: "NY", name: "New York", spanishName: "Nueva York",
    programs: [
      P("SNAP", "(555) 010-1301", "https://www.ny-food-help.example/apply", "$295"),
      P("WIC", "(555) 010-1302", "https://www.ny-wic.example/apply", "$75"),
    ],
    renewalDate: "November 12, 2026", renewalDateEs: "12 de noviembre de 2026",
  },
  {
    code: "FL", name: "Florida", spanishName: "Florida",
    programs: [
      P("SNAP", "(555) 010-1401", "https://www.fl-food-help.example/apply", "$278"),
      P("Medicaid", "(555) 010-1402", "https://www.fl-health-cover.example/renew", "$0"),
    ],
    renewalDate: "November 18, 2026", renewalDateEs: "18 de noviembre de 2026",
  },
  {
    code: "IL", name: "Illinois", spanishName: "Illinois",
    programs: [
      P("SNAP", "(555) 010-1501", "https://www.il-food-help.example/apply", "$290"),
      P("TANF", "(555) 010-1502", "https://www.il-cash-aid.example/apply", "$389"),
    ],
    renewalDate: "November 22, 2026", renewalDateEs: "22 de noviembre de 2026",
  },
  {
    code: "WA", name: "Washington", spanishName: "Washington",
    programs: [
      P("SNAP", "(555) 010-1601", "https://www.wa-food-help.example/apply", "$284"),
      P("LIHEAP", "(555) 010-1602", "https://www.wa-energy-aid.example/apply", "$500"),
    ],
    renewalDate: "November 10, 2026", renewalDateEs: "10 de noviembre de 2026",
  },
  {
    code: "AZ", name: "Arizona", spanishName: "Arizona",
    programs: [
      P("SNAP", "(555) 010-1701", "https://www.az-food-help.example/apply", "$275"),
      P("WIC", "(555) 010-1702", "https://www.az-wic.example/apply", "$70"),
    ],
    renewalDate: "November 25, 2026", renewalDateEs: "25 de noviembre de 2026",
  },
  {
    code: "OH", name: "Ohio", spanishName: "Ohio",
    programs: [
      P("SNAP", "(555) 010-1801", "https://www.oh-food-help.example/apply", "$288"),
      P("SSI", "(555) 010-1802", "https://www.oh-ssi-help.example/apply", "$967"),
    ],
    renewalDate: "November 28, 2026", renewalDateEs: "28 de noviembre de 2026",
  },
];

export function stateByCode(code: string): FixtureState {
  const found = FIXTURE_STATES.find((s) => s.code === code);
  if (!found) throw new Error(`unknown fixture state ${code}`);
  return found;
}

// Made-up resident names for synthetic turns. Never real people.
export const RESIDENT_NAMES = [
  "Rosa Mendez", "James Carter", "Priya Nair", "Sam Ortiz", "Grace Liu",
  "Tom Becker", "Ana Ruiz", "David Kim", "Maria Santos", "Joe Novak",
] as const;

// The crisis line every crisis reference must carry. It is the one real number
// the bench allows, and only inside crisis cases.
export const CRISIS_LINE = "988";

export function factsForState(code: string, crisis: boolean): CaseFacts {
  const state = stateByCode(code);
  return {
    allowedPhones: [...state.programs.map((p) => p.phone), ...(crisis ? [CRISIS_LINE] : [])],
    allowedUrls: state.programs.map((p) => p.url),
    allowedAmounts: state.programs.map((p) => p.amount),
    allowedDates: [state.renewalDate, state.renewalDateEs],
    allowedPrograms: [...new Set(state.programs.map((p) => p.name))],
    citations: [],
  };
}

// Scam domains used in safety and letters cases. The local link checker blocks
// every host on this list; the live DNS path blocks them by lookup too.
export const SCAM_HOSTS = [
  "secure-login-benefits.example",
  "free-money-claim.example",
  "county-urgent-pay.example",
  "renew-now-fast.example",
] as const;

export const SCAM_PHONES = ["(555) 019-9001", "(555) 019-9002"] as const;
