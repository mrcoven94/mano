import { describe, expect, it } from "vitest";
import { CRISIS_LINE, crisisFloor, holdCrisisLines, isCrisis } from "../src/crisis.js";
import { guardReply } from "../src/guard.js";

describe("isCrisis", () => {
  it("matches self-harm and danger phrasings", () => {
    for (const text of [
      "I can't do this anymore, I don't want to be here",
      "I can’t do this anymore, I don’t want to be here",
      "i want to die",
      "thinking about suicide",
      "I might kill myself tonight",
      "I cut myself again",
      "I'm in danger right now",
      "I don't feel safe at home",
      "he hit me again last night",
    ]) {
      expect(isCrisis(text), text).toBe(true);
    }
  });

  it("ignores ordinary venting and benefits phrasing", () => {
    for (const text of [
      "this deadline is killing me",
      "my back is killing me",
      "am I in danger of losing my benefits",
      "is it not safe to sign this",
      "the rent increase is hurting my budget",
      "hi",
      "I need diapers and I'm broke until friday",
    ]) {
      expect(isCrisis(text), text).toBe(false);
    }
  });
});

describe("crisisFloor", () => {
  it("keeps a reply that names 988 and 911", () => {
    const reply = "I'm so glad you said something. Call or text 988 now. If you're in danger, call 911. I'm here.";
    expect(crisisFloor(reply)).toBe(reply);
  });

  it("puts the crisis line first when the reply misses either number", () => {
    expect(crisisFloor("I'm here with you. Call 988.")).toBe(`${CRISIS_LINE} I'm here with you. Call 988.`);
    expect(crisisFloor("")).toBe(CRISIS_LINE);
  });

  it("writes the crisis line in the voice the guard enforces", () => {
    expect(guardReply(CRISIS_LINE)).toEqual({ text: CRISIS_LINE, changes: [] });
  });
});

describe("holdCrisisLines (review blocker 2)", () => {
  it("puts the crisis line first when the final bubbles miss either number", () => {
    expect(holdCrisisLines(["I'm here with you."])).toEqual([CRISIS_LINE, "I'm here with you."]);
    expect(holdCrisisLines(["Call 988 now.", "Or 911."])).toEqual(["Call 988 now.", "Or 911."]);
    expect(holdCrisisLines([])).toEqual([CRISIS_LINE]);
  });

  it("survives the guard dropping a sentence that named a provider", () => {
    const guarded = guardReply(crisisFloor("Call 988 or 911 through Meta.")).text;
    expect(holdCrisisLines([guarded]).join(" ")).toContain("988");
    expect(holdCrisisLines([guarded]).join(" ")).toContain("911");
  });
});
