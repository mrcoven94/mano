import { describe, expect, it } from "vitest";
import { mightBeCrisis } from "../src/crisis.js";

describe("cut my and cutting count only for a body part", () => {
  it("does not read a benefits or work cut as self-harm", () => {
    for (const text of ["they cut my food stamps. i have 2 kids", "they're cutting my hours", "they cut my benefits off"]) {
      expect(mightBeCrisis(text), text).toBe(false);
    }
  });

  it("reads cutting oneself as a crisis", () => {
    for (const text of ["I cut my wrists", "I've been cutting myself", "I'm going to cut my arm"]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
  });
});
