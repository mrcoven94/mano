import { describe, expect, it } from "vitest";

import { listPrograms, lookupProgram, screenIncome } from "../src/index.js";

describe("lookupProgram", () => {
  it("finds a program by state code and federal name", () => {
    expect(lookupProgram({ state: "CA", program: "snap" })?.name?.value).toBe("CalFresh");
  });

  it("takes the state's full name and the state's own program name, in any case", () => {
    expect(lookupProgram({ state: "california", program: "Medi-Cal" })?.program).toBe("medicaid");
    expect(lookupProgram({ state: "Texas", program: "CEAP" })?.program).toBe("liheap");
    expect(lookupProgram({ state: "WA", program: "basic food" })?.program).toBe("snap");
    expect(lookupProgram({ state: "AZ", program: "AHCCCS" })?.program).toBe("medicaid");
    expect(lookupProgram({ state: "NY", program: "food stamps" })?.program).toBe("snap");
    expect(lookupProgram({ state: "Nueva York", program: "SNAP" })?.state).toBe("NY");
  });

  it("returns null for a state or program it does not have", () => {
    expect(lookupProgram({ state: "VT", program: "snap" })).toBeNull();
    expect(lookupProgram({ state: "CA", program: "WIC" })).toBeNull();
  });

  it("returns every fact with its source and checked date", () => {
    const entry = lookupProgram({ state: "OH", program: "medicaid" })!;
    for (const fact of [entry.name, entry.phone, entry.website, entry.incomeLimit]) {
      expect(fact?.sourceUrl).toMatch(/^https:\/\//);
      expect(fact?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("listPrograms", () => {
  it("lists SNAP, Medicaid and LIHEAP for a state", () => {
    expect(listPrograms("FL").map((e) => e.program)).toEqual(["snap", "medicaid", "liheap"]);
  });

  it("is empty for a state it does not cover", () => {
    expect(listPrograms("Vermont")).toEqual([]);
  });
});

describe("screenIncome", () => {
  const calfresh = lookupProgram({ state: "CA", program: "snap" })!;
  const limitFor3 = calfresh.incomeLimit!.value.bySize[2]!;

  it("says a household at or under the gross limit may qualify, with the limit and its source", () => {
    const s = screenIncome(calfresh, { householdSize: 3, monthlyIncome: limitFor3 });
    expect(s.result).toBe("under_limit");
    expect(s.limit).toMatchObject({ amount: limitFor3, period: "monthly", householdSize: 3 });
    expect(s.sourceUrl).toBe(calfresh.incomeLimit!.sourceUrl);
  });

  it("says a household over the gross limit is over it, without ruling them out", () => {
    const s = screenIncome(calfresh, { householdSize: 3, monthlyIncome: limitFor3 + 1 });
    expect(s.result).toBe("over_limit");
    expect(s.note).toMatch(/agency decides/i);
  });

  it("uses the each-additional amount past the table", () => {
    const last = calfresh.incomeLimit!.value.bySize.length;
    const each = calfresh.incomeLimit!.value.eachAdditional!;
    const s = screenIncome(calfresh, { householdSize: last + 2, monthlyIncome: 0 });
    expect(s.limit?.amount).toBe(calfresh.incomeLimit!.value.bySize[last - 1]! + 2 * each);
  });

  it("compares a yearly limit with twelve months of income", () => {
    const ceap = lookupProgram({ state: "TX", program: "CEAP" })!;
    expect(ceap.incomeLimit!.value.period).toBe("annual");
    const yearly = ceap.incomeLimit!.value.bySize[0]!;
    expect(screenIncome(ceap, { householdSize: 1, monthlyIncome: yearly / 12 }).result).toBe("under_limit");
    expect(screenIncome(ceap, { householdSize: 1, monthlyIncome: yearly / 12 + 1 }).result).toBe("over_limit");
  });

  it("says unknown when there is no confirmed limit for that household size", () => {
    const ahcccs = lookupProgram({ state: "AZ", program: "medicaid" })!;
    const sizes = ahcccs.incomeLimit!.value.bySize.length;
    expect(ahcccs.incomeLimit!.value.eachAdditional).toBeNull();
    expect(screenIncome(ahcccs, { householdSize: sizes + 1, monthlyIncome: 100 }).result).toBe("unknown");
  });
});

// The never-promise rule: no screen result ever tells a person they qualify
// or are approved. These are the bench's promise patterns (packages/quality
// checks.ts PROMISE_RES), applied to every note a screen can produce.
const PROMISE = [
  /(?<!\b(?:what|whether|if|si)\s+)you\s+(qualify|are eligible|will be approved|are approved|are guaranteed)/i,
  /(?<!\b(?:what|whether|if|si)\s+)you're\s+(eligible|approved|guaranteed)/i,
  /you'll\s+(definitely\s+)?(qualify|be approved|be eligible)/i,
  /guaranteed\s+approval/i,
  /definitely\s+(qualify|eligible|approved)/i,
];

describe("a screen never promises eligibility", () => {
  const entries = ["CA", "TX", "NY", "FL", "IL", "WA", "AZ", "OH"].flatMap((s) => listPrograms(s));
  it.each([0, 500, 2000, 5000, 100000])("with %d a month, for every program and household size 1 to 10", (income) => {
    for (const entry of entries) {
      for (let size = 1; size <= 10; size++) {
        const { note } = screenIncome(entry, { householdSize: size, monthlyIncome: income });
        for (const re of PROMISE) expect(note).not.toMatch(re);
        expect(note).toMatch(/may|over|no confirmed/i);
      }
    }
  });
});
