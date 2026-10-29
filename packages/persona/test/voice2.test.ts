import { describe, expect, it } from "vitest";
import { allowedTapback, splitTapback } from "../src/tapbacks.js";
import { guardReply } from "../src/guard.js";
import { INTRO_LINE, MANO_SOUL } from "../src/soul.js";

describe("splitTapback", () => {
  it("reads a REACT: line as a tapback and leaves the rest as the reply", () => {
    expect(splitTapback("REACT: love")).toEqual({ tapback: "love", text: "" });
    expect(splitTapback("REACT: like\nI'll check in at 7")).toEqual({ tapback: "like", text: "I'll check in at 7" });
    expect(splitTapback("just text")).toEqual({ tapback: null, text: "just text" });
  });

  it("ignores reactions Mano does not send", () => {
    expect(splitTapback("REACT: dislike\nok")).toEqual({ tapback: null, text: "ok" });
  });
});

describe("allowedTapback", () => {
  it("never reacts in a crisis", () => {
    expect(allowedTapback("like", "ok", true)).toBeNull();
  });

  it("never puts a heart or a laugh on bad news", () => {
    expect(allowedTapback("love", "they cut my food stamps", false)).toBeNull();
    expect(allowedTapback("laugh", "we got denied again", false)).toBeNull();
    expect(allowedTapback("like", "they cut my food stamps", false)).toBe("like");
  });

  it("allows a heart on thanks", () => {
    expect(allowedTapback("love", "thank you!!", false)).toBe("love");
  });
});

describe("the guard and voice v2", () => {
  it("strips a leaked REACT: marker", () => {
    expect(guardReply("REACT: love").text).not.toContain("REACT");
  });

  it("keeps a checklist in one bubble", () => {
    expect(guardReply("you need 3 things:\n- your lease\n- a pay stub\n- your ID").text).toBe("you need 3 things:\nyour lease. a pay stub. your ID.");
  });

  it("opens without announcing an automated assistant, and the soul still requires saying so when asked", () => {
    expect(INTRO_LINE.toLowerCase()).not.toContain("automated");
    expect(INTRO_LINE).toContain("Mano");
    expect(MANO_SOUL).toContain("automated assistant");
    expect(guardReply(INTRO_LINE)).toEqual({ text: INTRO_LINE, changes: [] });
  });
});

describe("the broad crisis check and benefits cuts", () => {
  it("does not read a benefits cut as self-harm", async () => {
    const { mightBeCrisis } = await import("../src/crisis.js");
    for (const text of ["they cut my food stamps. i have 2 kids", "they're cutting my hours at work", "they cut my benefits off"]) {
      expect(mightBeCrisis(text), text).toBe(false);
    }
    for (const text of ["I'm going to cut my arm", "I keep cutting myself", "I cut my wrists"]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
  });
});
