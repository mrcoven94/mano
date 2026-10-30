import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import lookUpProgram, { inputSchema } from "../agent/tools/look_up_program.js";
import { toolCtx } from "./ctx.js";

const ctx = toolCtx({ handleHash: "c".repeat(64), turnId: "turn_programs01" });
const instructions = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");

type Out = Awaited<ReturnType<typeof lookUpProgram.execute>>;
const run = (input: Parameters<typeof lookUpProgram.execute>[0]) => lookUpProgram.execute(input, ctx) as Promise<Out>;

const OVER = /\bover\b|above|exceed|too (much|high)|ineligible|not eligible|(don't|do not|does not|doesn't|won't|will not) qualify|not qualify/i;

// The bench's promise patterns (packages/quality checks.ts PROMISE_RES).
const PROMISE = [
  /(?<!\b(?:what|whether|if|si)\s+)you\s+(qualify|are eligible|will be approved|are approved|are guaranteed)/i,
  /(?<!\b(?:what|whether|if|si)\s+)you're\s+(eligible|approved|guaranteed)/i,
  /you'll\s+(definitely\s+)?(qualify|be approved|be eligible)/i,
  /guaranteed\s+approval/i,
  /definitely\s+(qualify|eligible|approved)/i,
];

describe("look_up_program", () => {
  it("lists a state's programs by the state's own names, every fact with its source and date", async () => {
    const out = await run({ state: "California" });
    expect(out.found).toBe(true);
    if (!out.found) return;
    expect(out.programs.map((p) => p.name)).toEqual(["CalFresh", "Medi-Cal", expect.stringContaining("LIHEAP")]);
    for (const p of out.programs) {
      for (const fact of Object.values(p.facts)) {
        expect(fact.source).toMatch(/^https:\/\//);
        expect(fact.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("looks up one program by any of its names", async () => {
    const out = await run({ state: "TX", program: "CEAP" });
    expect(out.found && out.programs.map((p) => p.federalName)).toEqual(["LIHEAP"]);
  });

  it("never passes the source quotes to the model", async () => {
    const out = await run({ state: "OH" });
    expect(JSON.stringify(out)).not.toContain('"quote"');
  });

  it("names what it could not confirm, so the agent says so instead of guessing", async () => {
    const out = await run({ state: "TX", program: "liheap" });
    expect(out.found && out.programs[0]!.notConfirmed.map((g) => g.field)).toContain("phone");
  });

  it("says it has nothing for a state or program outside the catalog", async () => {
    for (const input of [{ state: "Vermont" }, { state: "CA", program: "WIC" }]) {
      const out = await run(input);
      expect(out.found).toBe(false);
      expect(!out.found && out.note).toMatch(/do not know/i);
    }
  });

  it("gives a rough screen when it has household size and monthly income, and never promises", async () => {
    const out = await run({ state: "WA", program: "Basic Food", householdSize: 3, monthlyIncome: 2100 });
    expect(out.found).toBe(true);
    if (!out.found) return;
    const screen = out.programs[0]!.screen!;
    expect(screen.result).toBe("may_qualify");
    expect(screen.note).toMatch(/may qualify/);
    for (const re of PROMISE) expect(JSON.stringify(out)).not.toMatch(re);
  });

  it("can't tell for $300 a month, size 3, Texas Medicaid, and never says over a limit (Sol)", async () => {
    const out = await run({ state: "TX", program: "medicaid", householdSize: 3, monthlyIncome: 300 });
    const screen = out.found ? out.programs[0]!.screen! : null;
    expect(screen?.result).toBe("cant_tell");
    expect(screen?.note).toMatch(/offer to help them apply/);
    expect(JSON.stringify(out.found && out.programs[0]!.screen)).not.toMatch(OVER);
  });

  it("uses what the person said about work to pick New York's SNAP table (Sol)", async () => {
    const out = await run({ state: "NY", program: "snap", householdSize: 1, monthlyIncome: 1900, earnedIncome: true });
    expect(out.found && out.programs[0]!.screen!.result).toBe("may_qualify");
  });

  it("takes no age or disability input, so a reported disability never selects a higher limit (Sol, round 2)", () => {
    const keys = Object.keys(inputSchema.shape);
    expect(keys).toContain("earnedIncome");
    expect(keys).not.toContain("elderlyOrDisabled");
    expect(keys).not.toContain("dependentCare");
  });

  it("gives a Brooklyn applicant New York City's route (Sol)", async () => {
    const out = await run({ state: "NY", program: "SNAP", place: "Brooklyn" });
    expect(out.found && out.programs[0]!.area).toBe("New York City");
    expect(out.found && out.programs[0]!.facts.website!.value).toMatch(/a069-access\.nyc\.gov/);
  });

  it("gives no screen without both numbers", async () => {
    const out = await run({ state: "WA", program: "snap", householdSize: 3 });
    expect(out.found && out.programs[0]!.screen).toBeUndefined();
  });
});

describe("the program instruction", () => {
  const rule = instructions.split("\n").find((l) => l.includes("look_up_program")) ?? "";

  it("states program facts only from the tool, by the state's name", () => {
    expect(rule).toMatch(/only (?:when|if) look_up_program returns it/);
    expect(rule).toMatch(/the state's own name/);
  });

  it("gives a rough screen that never promises eligibility", () => {
    expect(rule).toMatch(/may qualify/);
    expect(rule).toMatch(/Never say they qualify/);
    expect(rule).toMatch(/never that they are over a limit or do not qualify/);
  });

  it("says it does not know when the tool has nothing, and offers to check", () => {
    expect(rule).toMatch(/do not know/);
    expect(rule).toMatch(/offer to check/);
  });

  it("keeps the tool's details in the tool, not the instructions: one paragraph", () => {
    expect(instructions.split("\n").filter((l) => l.includes("look_up_program"))).toHaveLength(1);
  });
});
