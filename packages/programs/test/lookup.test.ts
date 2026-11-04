import { describe, expect, it } from "vitest";

import { limitAt, listPrograms, lookupProgram, screenIncome, type Household } from "../src/index.js";

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

describe("published rows and the add-on past them (Sol, should-fix 3)", () => {
  it("uses Texas's published size 9 Medicaid row, not size 8 plus the add-on", () => {
    const tx = lookupProgram({ state: "TX", program: "medicaid" })!;
    expect(limitAt(tx.incomeLimit!.value.tables[0]!, 9)).toBe(476);
  });

  it("uses Illinois's published size 9 Medicaid row", () => {
    const il = lookupProgram({ state: "IL", program: "medicaid" })!;
    expect(limitAt(il.incomeLimit!.value.tables[0]!, 9)).toBe(7061);
  });

  it("adds the published increment only past the last published row", () => {
    const table = { appliesTo: "test", bySize: [100, 200, 300], eachAdditional: 50 };
    expect(limitAt(table, 3)).toBe(300);
    expect(limitAt(table, 5)).toBe(400);
    expect(limitAt({ ...table, eachAdditional: null }, 4)).toBeNull();
    expect(limitAt({ ...table, bySize: [null, 200] }, 1)).toBeNull();
  });
});

describe("screenIncome (Sol's households)", () => {
  it("can't tell for $300 a month, size 3, Texas Medicaid: its limit is measured on MAGI, not gross pay", () => {
    const tx = lookupProgram({ state: "TX", program: "medicaid" })!;
    expect(tx.incomeLimit!.value.measuredOn).toBe("magi");
    const s = screenIncome(tx, { householdSize: 3, monthlyIncome: 300 });
    expect(s.result).toBe("cant_tell");
    expect(s.limit).toBeUndefined();
  });

  it("says a working single New Yorker at $1,900 may qualify for SNAP, by the earned-income table", () => {
    const ny = lookupProgram({ state: "NY", program: "snap" })!;
    const s = screenIncome(ny, { householdSize: 1, monthlyIncome: 1900, earnedIncome: true });
    expect(s.result).toBe("may_qualify");
    expect(s.limit?.amount).toBe(1995);
    expect(s.limit?.appliesTo).toMatch(/earned income/);
  });

  it("can't tell for the same New Yorker when it does not know whether anyone works", () => {
    const ny = lookupProgram({ state: "NY", program: "snap" })!;
    expect(screenIncome(ny, { householdSize: 1, monthlyIncome: 1900 }).result).toBe("cant_tell");
  });

  it("says may qualify under every table that could apply, using the lowest", () => {
    const ny = lookupProgram({ state: "NY", program: "snap" })!;
    const s = screenIncome(ny, { householdSize: 1, monthlyIncome: 1700 });
    expect(s.result).toBe("may_qualify");
    expect(s.limit?.amount).toBe(1729);
  });

  it("compares a yearly gross limit with twelve months of income", () => {
    const heap = lookupProgram({ state: "AZ", program: "liheap" })!;
    expect(heap.incomeLimit!.value.measuredOn).toBe("gross");
    const table = heap.incomeLimit!.value.tables[0]!;
    const monthly = heap.incomeLimit!.value.period === "annual" ? limitAt(table, 2)! / 12 : limitAt(table, 2)!;
    expect(screenIncome(heap, { householdSize: 2, monthlyIncome: monthly }).result).toBe("may_qualify");
  });

  it("can't tell when the limit is not measured on gross income", () => {
    const ceap = lookupProgram({ state: "TX", program: "CEAP" })!;
    expect(ceap.incomeLimit!.value.measuredOn).toBe("unstated");
    expect(screenIncome(ceap, { householdSize: 1, monthlyIncome: 0 }).result).toBe("cant_tell");
  });

  it("can't tell when a table that could apply publishes no amounts", () => {
    const il = lookupProgram({ state: "IL", program: "liheap" })!;
    expect(screenIncome(il, { householdSize: 1, monthlyIncome: 0 }).result).toBe("cant_tell");
  });

  it("can't tell past the published sizes when there is no published add-on", () => {
    const ahcccs = lookupProgram({ state: "AZ", program: "medicaid" })!;
    expect(screenIncome(ahcccs, { householdSize: 6, monthlyIncome: 0 }).result).toBe("cant_tell");
  });
});

describe("a higher table only from a fact the tool collects exactly (Sol, round 2)", () => {
  it("can't tell for a 40-year-old in Illinois reporting a disability at $2,400: the 200% table needs IDHS's listed benefits", () => {
    const il = lookupProgram({ state: "IL", program: "snap" })!;
    const reported = { householdSize: 1, monthlyIncome: 2400, elderlyOrDisabled: true } as Household;
    expect(screenIncome(il, reported).result).toBe("cant_tell");
    const under = screenIncome(il, { householdSize: 1, monthlyIncome: 2195 });
    expect(under.result).toBe("may_qualify");
    expect(under.limit?.amount).toBe(2195);
  });

  it("can't tell for a 70-year-old in Arizona at $1,700: the 65 or older limit is $1,330", () => {
    const ahcccs = lookupProgram({ state: "AZ", program: "medicaid" })!;
    expect(screenIncome(ahcccs, { householdSize: 1, monthlyIncome: 1700, elderlyOrDisabled: true } as Household).result).toBe("cant_tell");
    expect(screenIncome(ahcccs, { householdSize: 1, monthlyIncome: 1330 }).limit?.amount).toBe(1330);
  });

  it("can't tell for a categorically eligible Washington household at $1,900, and says how to check", () => {
    const wa = lookupProgram({ state: "WA", program: "snap" })!;
    const s = screenIncome(wa, { householdSize: 1, monthlyIncome: 1900 });
    expect(s.result).toBe("cant_tell");
    expect(s.note).toMatch(/how to check with the office/);
  });
});

describe("New York City applies through ACCESS HRA (Sol, should-fix 4)", () => {
  it("gives a Brooklyn applicant the city's route, with its own source", () => {
    const snap = lookupProgram({ state: "NY", program: "snap", place: "Brooklyn" })!;
    expect(snap.area).toBe("New York City");
    expect(snap.website?.value).toMatch(/^https:\/\/a069-access\.nyc\.gov\//);
    expect(snap.apply?.value).toMatch(/ACCESS HRA/);
    expect(snap.apply?.sourceUrl).toMatch(/nyc\.gov/);
    expect(snap.renewal?.sourceUrl).toMatch(/nyc\.gov/);
  });

  it("keeps the statewide route outside the city", () => {
    const snap = lookupProgram({ state: "NY", program: "snap", place: "Albany" })!;
    expect(snap.area).toBeUndefined();
    expect(snap.website?.value).toMatch(/mybenefits\.ny\.gov/);
  });
});

// The screen never tells a person they are over a limit or do not qualify:
// it says they may qualify, or that it can't tell. These are the bench's
// promise patterns (packages/quality checks.ts PROMISE_RES) and the words of
// an over-limit answer, applied to every result a screen can produce.
const PROMISE = [
  /(?<!\b(?:what|whether|if|si)\s+)you\s+(qualify|are eligible|will be approved|are approved|are guaranteed)/i,
  /(?<!\b(?:what|whether|if|si)\s+)you're\s+(eligible|approved|guaranteed)/i,
  /you'll\s+(definitely\s+)?(qualify|be approved|be eligible)/i,
  /guaranteed\s+approval/i,
  /definitely\s+(qualify|eligible|approved)/i,
];
const OVER = /\bover\b|above|exceed|too (much|high)|ineligible|not eligible|(don't|do not|does not|doesn't|won't|will not) qualify|not qualify/i;

describe("a screen never promises and never says over the limit", () => {
  const entries = ["CA", "TX", "NY", "FL", "IL", "WA", "AZ", "OH"].flatMap((s) => listPrograms(s));
  // elderlyOrDisabled and dependentCare are what a caller might pass; the
  // screen must ignore them.
  const facts = [{}, { earnedIncome: true }, { earnedIncome: false }, { elderlyOrDisabled: true }, { earnedIncome: true, elderlyOrDisabled: true, dependentCare: true }];
  // The lowest limit among every table that could apply to this household
  // size; only earned income, which the tool asks as the sources define it,
  // can rule a table out.
  const lowest = (entry: (typeof entries)[number], size: number, earnedIncome?: boolean) => {
    const tables = entry.incomeLimit!.value.tables.filter((t) => earnedIncome === undefined || !t.when || t.when.some((c) => c.earnedIncome === undefined || c.earnedIncome === earnedIncome));
    const amounts = tables.map((t) => limitAt(t, size));
    return amounts.some((a) => a === null) ? null : Math.min(...(amounts as number[]));
  };
  it.each([0, 300, 1900, 5000, 100000])("with %d a month, for every program, household size 0 to 12 and household facts", (income) => {
    for (const entry of entries) {
      for (let size = 0; size <= 12; size++) {
        for (const f of facts) {
          const s = screenIncome(entry, { householdSize: size, monthlyIncome: income, ...f } as Household);
          expect(["may_qualify", "cant_tell"]).toContain(s.result);
          const said = JSON.stringify(s);
          for (const re of PROMISE) expect(said).not.toMatch(re);
          expect(said).not.toMatch(OVER);
          if (s.result === "cant_tell") expect(s.limit).toBeUndefined();
          if (s.result === "may_qualify") {
            const floor = lowest(entry, size, (f as { earnedIncome?: boolean }).earnedIncome);
            expect(floor).not.toBeNull();
            expect(s.limit!.amount).toBe(floor);
            expect(entry.incomeLimit!.value.period === "annual" ? income * 12 : income).toBeLessThanOrEqual(floor!);
          }
        }
      }
    }
  });
});
