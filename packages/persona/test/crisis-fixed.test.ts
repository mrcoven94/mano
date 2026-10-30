// The crisis decision held to a fixed list: every string the PR 77
// comparison covered (all test and suite strings, plus 200 adversarial
// health strings), with main's answer at the merge base and the answer
// now. A change that moves any of them fails here, so a regression can
// never land silently. A string main calls a crisis may stop being one
// only if it is an ordinary health look-alike listed below.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crisisTurn } from "../src/crisis.js";

interface Row {
  text: string;
  main: boolean;
  crisis: boolean;
}

const { rows } = JSON.parse(readFileSync(new URL("./fixtures/crisis-cases.json", import.meta.url), "utf8")) as { rows: Row[] };

// The only strings main calls a crisis that are not: plain health
// questions, the bare adversarial health heads, and their "lol" variants.
const HEALTH_LOOKALIKES = new Set([
  "I forgot to take my pills",
  "I forgot to take my pills lol",
  "I forgot to take my pills this morning, should I take them now?",
  "I hurt my back at work",
  "I hurt my back at work lol",
  "I hurt my back at work, can I get disability?",
  "Is it malpractice that my surgery hurt for weeks?",
  "My tooth hurts and I don't have dental coverage.",
  "Should I stop taking my blood pressure pills?",
  "Should I stop taking my blood pressure pills? lol",
  "The surgery still hurts. Does Medi-Cal pay for a follow up?",
  "can I switch my birth control pills",
  "can I switch my birth control pills lol",
  "can I switch my birth control pills to a cheaper brand?",
  "does medicaid cover my allergy pills",
  "does medicaid cover my allergy pills lol",
  "does medicaid cover my allergy pills?",
  "my back hurts and I can't afford a chiropractor",
  "my knee hurts",
  "my knee hurts lol",
  "my knee still hurts after the surgery, can medicaid cover physical therapy?",
  "my surgery hurt for weeks",
  "my surgery hurt for weeks lol",
  "my tooth hurts",
  "my tooth hurts lol",
  "the surgery still hurts",
  "the surgery still hurts lol",
]);

describe("the crisis decision on a fixed list of strings", () => {
  it("covers the whole comparison", () => {
    expect(rows.length).toBeGreaterThanOrEqual(1998);
  });

  it("gives every string its recorded answer", () => {
    const moved = rows.filter((r) => crisisTurn(r.text) !== r.crisis).map((r) => r.text);
    expect(moved).toEqual([]);
  });

  it("never turns a crisis main catches into a non-crisis, except a listed health look-alike", () => {
    const lost = rows.filter((r) => r.main && !r.crisis).map((r) => r.text);
    expect(lost.filter((t) => !HEALTH_LOOKALIKES.has(t))).toEqual([]);
  });
});
