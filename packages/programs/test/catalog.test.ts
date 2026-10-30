import { describe, expect, it } from "vitest";

import { CATALOG, PROGRAMS, STATES, validateCatalog, type StateCatalog, type StateCode } from "../src/index.js";

const TODAY = "2026-10-30";

function copy(): Record<StateCode, StateCatalog> {
  return structuredClone(CATALOG);
}

describe("the catalog", () => {
  it("passes its own check: every fact sourced, dated, quoted and official", () => {
    expect(validateCatalog(CATALOG, TODAY)).toEqual([]);
  });

  it("covers SNAP, Medicaid and LIHEAP in all eight states, by the state's name", () => {
    for (const state of STATES) {
      for (const program of PROGRAMS) {
        const entry = CATALOG[state].programs[program];
        expect(entry.state).toBe(state);
        expect(entry.program).toBe(program);
        expect(entry.name?.value.trim()).toBeTruthy();
      }
    }
    expect(CATALOG.CA.programs.snap.name?.value).toBe("CalFresh");
    expect(CATALOG.CA.programs.medicaid.name?.value).toBe("Medi-Cal");
    expect(CATALOG.WA.programs.medicaid.name?.value).toBe("Apple Health");
    expect(CATALOG.AZ.programs.medicaid.name?.value).toBe("AHCCCS");
    expect(CATALOG.TX.programs.liheap.name?.value).toContain("CEAP");
  });

  it("labels every income limit with the year it is for", () => {
    for (const state of STATES) {
      for (const program of PROGRAMS) {
        const limit = CATALOG[state].programs[program].incomeLimit;
        if (limit) expect(limit.value.year).toMatch(/20\d\d/);
      }
    }
  });
});

describe("the check fails", () => {
  it("on a fact with no source", () => {
    const c = copy();
    c.CA.programs.snap.phone!.sourceUrl = "";
    expect(validateCatalog(c, TODAY)).toContain("CA snap phone: no source");
  });

  it("on a fact with no checked date, or one in the future", () => {
    const c = copy();
    c.TX.programs.medicaid.renewal!.checkedAt = "";
    c.NY.programs.liheap.covers!.checkedAt = "2026-11-02";
    const problems = validateCatalog(c, TODAY);
    expect(problems).toContain("TX medicaid renewal: no checked date");
    expect(problems.some((p) => p.startsWith("NY liheap covers: checked date 2026-11-02"))).toBe(true);
  });

  it("on a source that is not on .gov or a documented state site", () => {
    const c = copy();
    c.FL.programs.snap.incomeLimit!.sourceUrl = "https://www.propel.app/snap/florida";
    expect(validateCatalog(c, TODAY).some((p) => p.startsWith("FL snap incomeLimit: source https://www.propel.app"))).toBe(true);
  });

  it("on a source served over plain http, even on .gov", () => {
    const c = copy();
    c.IL.programs.snap.name!.sourceUrl = "http://www.dhs.state.il.us/page.aspx?item=30357";
    expect(validateCatalog(c, TODAY).some((p) => p.startsWith("IL snap name: source http://"))).toBe(true);
  });

  it("on a website that is not official", () => {
    const c = copy();
    c.WA.programs.snap.website!.value = "https://www.getcalfresh.org/";
    expect(validateCatalog(c, TODAY).some((p) => p.startsWith("WA snap website:"))).toBe(true);
  });

  it("on a phone value that is not one phone number", () => {
    const c = copy();
    c.OH.programs.snap.phone!.value = "call your county office";
    expect(validateCatalog(c, TODAY).some((p) => p.startsWith("OH snap phone:"))).toBe(true);
  });

  it("on a missing field that the gaps do not explain", () => {
    const c = copy();
    delete c.AZ.programs.liheap.phone;
    c.AZ.programs.liheap.gaps = c.AZ.programs.liheap.gaps.filter((g) => !g.field.startsWith("phone"));
    expect(validateCatalog(c, TODAY)).toContain("AZ liheap phone: missing and not named in gaps");
  });

  it("on a documented site that no .gov page documents", () => {
    const c = copy();
    c.CA.documentedSites[0]!.sourceUrl = "https://benefitscal.com/about";
    expect(validateCatalog(c, TODAY).some((p) => p.startsWith(`CA site ${c.CA.documentedSites[0]!.host}: documented by https://benefitscal.com`))).toBe(true);
  });

  it("on an income table that shrinks with household size", () => {
    const c = copy();
    c.NY.programs.snap.incomeLimit!.value.tables[0]!.bySize = [2000, 1500];
    expect(validateCatalog(c, TODAY)).toContain("NY snap incomeLimit table 1: amounts must be positive and grow with household size");
  });
});
