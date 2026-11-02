// Sol's review of PR 77 at 297660e: real crises main catches that the
// first health exemption missed, and safety content the first dedupe
// deleted. Every string here must keep main's answer.
import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, crisisTurn, holdCrisisLines } from "../src/crisis.js";

describe("crises a health question cannot hide (Sol, blockers 1 to 3)", () => {
  const crises = [
    // 1: numbered overdose.
    "I took 40 blood pressure pills.",
    "I took twenty blood pressure pills.",
    "I took 15 of my heart pills",
    "took a lot of my blood pressure pills",
    "I took a bottle of my allergy pills",
    // 2: intentional injury, and someone else hurting them.
    "I hurt my arm on purpose.",
    "He hurt my arm on purpose and will not let me leave.",
    "my boyfriend hurt my back and won't let me leave",
    "I cut my arm on purpose, does medicaid cover stitches?",
    // 3: stopping a medication to die, and passive ideation.
    "I am going to stop taking my heart pills so I never wake up.",
    "My surgery hurts. I hope I never wake up.",
    "My surgery hurts. Ojalá no despertara mañana.",
    "My surgery hurts and I want it to stop forever.",
    "my back hurts, I can't do this anymore",
    "I'm going to skip my blood pressure pills and not wake up",
    "My knee hurts. No quiero despertar mañana.",
    "my surgery hurts so much I want to die",
    "Should I stop my heart pills? There's no point anymore.",
    "my stomach hurts after I swallowed bleach",
  ];
  for (const text of crises) {
    it(`"${text}" stays a crisis`, () => {
      expect(crisisTurn(text)).toBe(true);
    });
  }
});

describe("passive ideation is a crisis even with no other crisis word (Sol, should-fix 5)", () => {
  for (const text of [
    "I swallowed poison because I hope I never wake up. What should I do?",
    "I hope I don't wake up tomorrow",
    "Ojalá no despertara mañana.",
    "No quiero despertar mañana.",
  ]) {
    it(`"${text}" is a crisis`, () => {
      expect(crisisTurn(text)).toBe(true);
    });
  }
});

describe("the dedupe never deletes help or a question (Sol, blocker 4)", () => {
  it("keeps a sentence that names another resource or number", () => {
    expect(holdCrisisLines(["Call Poison Control at 1-800-222-1222 as well as 911."])).toEqual([CRISIS_LINE, "Call Poison Control at 1-800-222-1222 as well as 911."]);
    expect(holdCrisisLines(["In the UK call 999 rather than 911."])).toEqual([CRISIS_LINE, "In the UK call 999 rather than 911."]);
  });

  it("keeps a sentence that gives an action", () => {
    expect(holdCrisisLines(["Move away from the pills and ask someone to stay with you while you call 911."])[1]).toBe(
      "Move away from the pills and ask someone to stay with you while you call 911.",
    );
  });

  it("keeps a sentence that asks, even when its question mark is missing", () => {
    // Marks come back only on a whole safety question (Sol's second review, 6).
    expect(holdCrisisLines(["Call 988 now, are you safe right now"])).toEqual([CRISIS_LINE, "Call 988 now, are you safe right now"]);
    expect(holdCrisisLines(["llama al 988, estás a salvo ahora mismo"], CRISIS_LINE_ES)).toEqual([CRISIS_LINE_ES, "llama al 988, estás a salvo ahora mismo"]);
  });

  it("still deletes a bare call to 988 or 911, and a near-exact repeat of the line", () => {
    expect(holdCrisisLines(["Call or text 988 now.", "Please call or text 988 right now, it's free and open 24/7", "if you're in danger right now, call 911."])).toEqual([CRISIS_LINE]);
    expect(holdCrisisLines(["Envía un mensaje al 988 ahora mismo.", "Si estás en peligro ahora mismo, llama al 911."], CRISIS_LINE_ES)).toEqual([CRISIS_LINE_ES]);
  });
});
