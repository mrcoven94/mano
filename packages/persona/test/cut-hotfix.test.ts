import { describe, expect, it } from "vitest";
import { isCrisis, mightBeCrisis } from "../src/crisis.js";

describe("cut my and cutting count only for a body part", () => {
  it("does not read a benefits or work cut as self-harm", () => {
    for (const text of [
      "they cut my food stamps. i have 2 kids",
      "they're cutting my hours",
      "they cut my benefits off",
      "they cut my SNAP",
      "my boss is cutting my shifts",
      "they cut my pay",
      "they're cutting my medicaid",
      "they cut my power",
      "I need to cut my bills",
      "can't afford to cut my hair",
      "they cut our SNAP",
      "they're cutting back my shifts",
      "the office cut off my phone",
    ]) {
      expect(mightBeCrisis(text), text).toBe(false);
    }
  });

  it("reads cutting oneself as a crisis, for any body part", () => {
    for (const text of [
      "I cut my wrists",
      "I've been cutting myself",
      "I'm going to cut my arm",
      "I keep cutting my forearms",
      "I cut my stomach again",
      "I cut my legs last night",
      "I've been cutting my arms",
      "I cut myself",
      "I've been cutting again to punish myself",
      "I keep cutting",
      "I cut again last night",
    ]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
  });
});

describe("the benefits danger exclusion stays narrow", () => {
  it("still reads a crisis later in the same sentence", () => {
    expect(mightBeCrisis("we're in danger of being cut off and he hit me")).toBe(true);
    expect(mightBeCrisis("we're in danger of being cut off")).toBe(false);
  });
});

describe("in danger counts unless a benefits word follows (PR 70 round 3)", () => {
  it("reads danger to a person as a crisis", () => {
    for (const text of ["I am in danger of being killed", "in danger of losing control, cutting again", "in danger of being hurt"]) {
      expect(mightBeCrisis(text), text).toBe(true);
      expect(isCrisis(text), text).toBe(true);
    }
  });

  it("keeps danger to benefits a benefits question", () => {
    for (const text of ["in danger of losing my benefits", "in danger of being evicted", "in danger of losing my SNAP", "we're in danger of being cut off", "in danger of being kicked out"]) {
      expect(mightBeCrisis(text), text).toBe(false);
    }
  });
});
