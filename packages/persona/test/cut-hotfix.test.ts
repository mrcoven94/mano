import { describe, expect, it } from "vitest";
import { mightBeCrisis } from "../src/crisis.js";

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
    ]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
  });
});
