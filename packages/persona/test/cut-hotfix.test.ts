import { describe, expect, it } from "vitest";
import { crisisTurn, isCrisis, mightBeCrisis, suppressedBenefitsCut } from "../src/crisis.js";

describe("benefits cuts are suppressed only as exact template sentences", () => {
  it("suppresses someone else cutting a listed benefit, sentence by sentence", () => {
    for (const text of [
      "they cut my food stamps",
      "they cut my food stamps. i have 2 kids",
      "they're cutting my hours",
      "they cut my benefits off",
      "they cut my SNAP",
      "my boss is cutting my shifts",
      "they cut my pay",
      "they're cutting my medicaid",
      "they cut my power",
      "they cut our SNAP",
      "they’re cutting back my shifts",
      "the county cut our SNAP",
      "the office cut off my phone",
      "They cut my food stamps!",
    ]) {
      expect(crisisTurn(text), text).toBe(false);
    }
  });

  it("accepts over-triggering on anything that is not exactly the template", () => {
    for (const text of ["can't afford to cut my hair", "I need to cut my bills", "they're cutting my hours at work"]) {
      expect(crisisTurn(text), text).toBe(true);
    }
  });
});

describe("every crisis Sol found still triggers", () => {
  it("reads self-harm, danger and violence in every earlier input", () => {
    for (const text of [
      "I cut my wrists",
      "I've been cutting myself",
      "I'm going to cut my arm",
      "I keep cutting my forearms",
      "I cut my stomach again",
      "I cut my legs last night",
      "I've been cutting again to punish myself",
      "I keep cutting",
      "I'm cutting myself over rent",
      "To punish myself I cut my leg hours ago.",
      "I cut my arm. Rent is due.",
      "I am in danger of being killed over rent",
      "I am in danger of being threatened over rent",
      "I am in danger of being hit over rent",
      "in danger of losing control, cutting again",
      "they cut my SNAP and I want to die",
      "they cut my food stamps. I want to die.",
      "cutting my hours, I can't do this anymore, I want to end it",
      "he is cutting my hair and my throat",
      "I want to end my\nlife",
      "they cut my SNAP\nI want to end my\nlife",
    ]) {
      expect(crisisTurn(text), text).toBe(true);
    }
  });
});

describe("the detectors are main's, unchanged", () => {
  it("still fires before suppression on a template sentence", () => {
    expect(mightBeCrisis("they cut my food stamps")).toBe(true);
    expect(suppressedBenefitsCut("they cut my food stamps")).toBe(true);
    expect(isCrisis("I want to die")).toBe(true);
  });

  it("keeps main's danger-to-benefits behavior", () => {
    for (const text of ["in danger of losing my benefits", "in danger of being evicted", "we're in danger of being cut off"]) {
      expect(crisisTurn(text), text).toBe(false);
    }
  });
});
