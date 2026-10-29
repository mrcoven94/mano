import { describe, expect, it } from "vitest";
import { CRISIS_LINE, SAFETY_LINE, crisisFloor, holdCrisisLines, isCrisis, mightBeCrisis, namesCrisisLines } from "../src/crisis.js";
import { SAFE_REPLY, guardReply } from "../src/guard.js";

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

describe("holdCrisisLines (review blocker 2, made structural in PR 67 round 4)", () => {
  it("always puts the crisis line first, once", () => {
    expect(holdCrisisLines(["I'm here with you."])).toEqual([CRISIS_LINE, "I'm here with you."]);
    expect(holdCrisisLines(["Call 988 now.", "Or 911."])).toEqual([CRISIS_LINE, "Call 988 now.", "Or 911."]);
    expect(holdCrisisLines([])).toEqual([CRISIS_LINE]);
  });

  it("survives the guard dropping a sentence that named a provider", () => {
    const guarded = guardReply(crisisFloor("Call 988 or 911 through Llama.")).text;
    expect(holdCrisisLines([guarded]).join(" ")).toContain("988");
    expect(holdCrisisLines([guarded]).join(" ")).toContain("911");
  });
});

describe("isCrisis, direct disclosures (review round 3, blocker 1)", () => {
  it("matches violence and immediate danger", () => {
    for (const text of [
      "I am in immediate danger",
      "My husband hit me",
      "He is hitting me",
      "he hurt me again",
      "my boyfriend is abusive",
      "I feel unsafe at home",
      "he said he is going to kill me",
      "I've been thinking about suicide",
    ]) {
      expect(isCrisis(text), text).toBe(true);
    }
  });

  it("keeps benefits and money worries out", () => {
    for (const text of [
      "I am in danger of losing my benefits.",
      "this deadline is killing me",
      "losing SNAP would kill my budget",
    ]) {
      expect(isCrisis(text), text).toBe(false);
    }
  });
});

describe("SAFETY_LINE", () => {
  it("names 988 and 911 in one sentence, in the voice the guard enforces", () => {
    expect(namesCrisisLines(SAFETY_LINE)).toBe(true);
    expect(guardReply(SAFETY_LINE)).toEqual({ text: SAFETY_LINE, changes: [] });
    expect(namesCrisisLines(SAFE_REPLY)).toBe(true);
  });
});

describe("explicit danger wins over the benefits exclusion (review round 4, blocker 1b)", () => {
  it("treats explicit danger as a crisis even next to housing or money words", () => {
    for (const text of ["I am in immediate danger. My landlord is outside.", "I am not safe in my apartment", "my apartment is unsafe, he is outside"]) {
      expect(isCrisis(text), text).toBe(true);
    }
    expect(isCrisis("I am in danger of losing my benefits.")).toBe(false);
  });
});

describe("mightBeCrisis (review round 4, blocker 1a)", () => {
  it("is broad and has no exclusions", () => {
    for (const text of ["things at home got really bad tonight", "I'm scared", "he threatened me", "I am not safe in my apartment", "is it safe to stay here"]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
    for (const text of ["hello", "what does SNAP stand for", "ok thanks"]) {
      expect(mightBeCrisis(text), text).toBe(false);
    }
  });
});
