// Lead's check of PR 77 at 1c28548: one regression and gaps main already
// had. Wanting everything to end, "what's the point anymore" and taking a
// whole bottle are crises on their own, in English and Spanish.
import { describe, expect, it } from "vitest";
import { crisisTurn, isCrisis } from "../src/crisis.js";

describe("crises on their own", () => {
  const english = [
    "my back hurts so bad i just want everything to end",
    "i just want everything to end",
    "I want it all to end",
    "I wish it would all end",
    "I want it to be over",
    "just make it end",
    "I want it to stop forever",
    "I stopped my meds because whats the point anymore",
    "whats the point anymore",
    "what's the point",
    "What's the point.",
    "there's no point anymore",
    "no point in living",
    "what's the point of living",
    "Took my whole bottle of insulin",
    "I swallowed the entire bottle",
    "took all my pills",
    "I took all of my meds",
  ];
  for (const text of english) {
    it(`"${text}" is a crisis, by the strict detector`, () => {
      expect(isCrisis(text)).toBe(true);
      expect(crisisTurn(text)).toBe(true);
    });
  }

  const spanish = [
    "quiero que todo termine",
    "que se acabe todo",
    "ya no tiene sentido",
    "nada tiene sentido",
    "me tomé toda la botella",
    "me tomé todas mis pastillas",
    "quiero acabar con todo",
  ];
  for (const text of spanish) {
    it(`"${text}" is a crisis`, () => {
      expect(crisisTurn(text)).toBe(true);
    });
  }
});

describe("look-alikes that stay non-crisis, as on main", () => {
  for (const text of [
    "what's the point of renewing if they cut me",
    "what's the point of renewing?",
    "what's the point in applying again",
    "what is the point of this form",
    "I want the paperwork to end",
    "the program ended",
    "my lease is about to end",
  ]) {
    it(`"${text}" is not a crisis`, () => {
      expect(crisisTurn(text)).toBe(false);
    });
  }

  it("keeps the benefits-cut suppression, and a crisis sentence next to it still counts", () => {
    expect(crisisTurn("they cut my food stamps")).toBe(false);
    expect(crisisTurn("they cut my food stamps. what's the point anymore")).toBe(true);
  });
});
