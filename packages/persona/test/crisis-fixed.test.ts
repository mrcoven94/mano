// The crisis decision held to a fixed list: every string the PR 77
// comparison covered (all test and suite strings, plus 200 adversarial
// health strings), with main's answer at the merge base, this branch's
// keyword floor, and whether the model check may be asked. A change that
// moves any of them fails here, so a regression can never land silently.
// Two runs, as the lead asked after Sol's third review:
// - a fake check that always says "yes": the decision equals the floor,
//   which is main plus the new detections, and loses no crisis main catches;
// - a fake check that always says "no": the most the model could ever
//   exempt, which must be exactly the one-short-health-question set.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crisisTurn, decideCrisis, isOneHealthQuestion, mentionsInstructions, type CrisisCheck } from "../src/crisis.js";

interface Row {
  text: string;
  main: boolean;
  crisis: boolean;
  oneQuestion: boolean;
}

const { rows } = JSON.parse(readFileSync(new URL("./fixtures/crisis-cases.json", import.meta.url), "utf8")) as { rows: Row[] };
const always = (answer: string): CrisisCheck => ({ live: true, ask: async () => answer });

describe("the crisis decision on a fixed list of strings", () => {
  it("covers the whole comparison", () => {
    expect(rows.length).toBeGreaterThanOrEqual(2110);
  });

  it("gives every string its recorded floor and gate", () => {
    expect(rows.filter((r) => crisisTurn(r.text) !== r.crisis).map((r) => r.text)).toEqual([]);
    expect(rows.filter((r) => (r.crisis && isOneHealthQuestion(r.text) && !mentionsInstructions(r.text)) !== r.oneQuestion).map((r) => r.text)).toEqual([]);
  });

  it("with a check that always says yes, equals the floor and drops no crisis main catches", async () => {
    const yes = always("yes");
    const moved: string[] = [];
    for (const r of rows) if ((await decideCrisis(r.text, yes)).crisis !== r.crisis) moved.push(r.text);
    expect(moved).toEqual([]);
    expect(rows.filter((r) => r.main && !r.crisis).map((r) => r.text)).toEqual([]);
  });

  it("with a check that always says no, exempts exactly the one-short-health-question set", async () => {
    const no = always("no");
    const exempted: string[] = [];
    for (const r of rows) if (r.crisis && !(await decideCrisis(r.text, no)).crisis) exempted.push(r.text);
    expect(exempted).toEqual(rows.filter((r) => r.oneQuestion).map((r) => r.text));
  });
});
