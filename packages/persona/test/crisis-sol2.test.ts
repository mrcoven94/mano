// Sol's second review of PR 77 at 6be90d9, and the lead's design change:
// only ONE short health question is exempt. Everything else that main's
// detector calls a crisis stays one.
import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, crisisTurn, holdCrisisLines, isCrisis } from "../src/crisis.js";
import { MANO_SOUL } from "../src/soul.js";

describe("only one short health question is exempt", () => {
  for (const text of [
    "Is it malpractice that my surgery hurt for weeks?",
    "Should I stop taking my blood pressure pills?",
    "Can I switch my birth control pills to a cheaper brand?",
    "Does medicaid cover my allergy pills?",
  ]) {
    it(`"${text}" is exempt`, () => {
      expect(crisisTurn(text)).toBe(false);
    });
  }

  for (const text of [
    // Sol's strings.
    "I hurt my arm intentionally.",
    "I took my blood pressure pills by the handful.",
    "I take my heart pills forty at a time.",
    "My back hurts. I wish I had never been born.",
    "My surgery hurts. No tengo ganas de vivir.",
    "I'm going to stop taking my heart pills because life isn't worth living.",
    "My back hurts and I want it to stop.",
    // Not one question, so not exempt any more.
    "I hurt my back at work, can I get disability?",
    "my back hurts and I can't afford a chiropractor",
    "The surgery still hurts. Does Medi-Cal pay for a follow up?",
    "Should I stop taking my blood pressure pills? lol",
    // A question with an intent clause.
    "Should I stop taking my heart pills because I want to die?",
    "Is it ok if I stop my heart pills so I never wake up?",
    "Can I skip my blood pressure pills, I hope it ends?",
    "¿Debo dejar mis pastillas para el corazón porque quiero morir?",
  ]) {
    it(`"${text}" stays a crisis`, () => {
      expect(crisisTurn(text)).toBe(true);
    });
  }

  it("detects a plan to take one's own life (Sol, blocker 4)", () => {
    expect(isCrisis("I am planning to take my own life tonight.")).toBe(true);
    expect(crisisTurn("I am planning to take my own life tonight.")).toBe(true);
  });
});

describe("the shared soul keeps the crisis numbers (Sol, blocker 4)", () => {
  it("tells the model to give 988 and 911 in a crisis, and says nothing about the line being sent", () => {
    expect(MANO_SOUL).toMatch(/988 \(call or text\) for suicide or crisis, 911 for immediate danger/);
    expect(MANO_SOUL).not.toMatch(/first on its own/);
  });
});

describe("the dedupe drops only the same number with the same action (Sol, 5)", () => {
  it("keeps a sentence with a different action for a number", () => {
    expect(holdCrisisLines(["Text 911 if you're in danger."])).toEqual([CRISIS_LINE, "Text 911 if you're in danger."]);
  });

  it("still drops the same number with the same action and nothing else", () => {
    expect(holdCrisisLines(["Call or text 988 now.", "If you're in danger right now, call 911."])).toEqual([CRISIS_LINE]);
    expect(holdCrisisLines(["Por favor llama o manda texto al 988 ahora mismo."], CRISIS_LINE_ES)).toEqual([CRISIS_LINE_ES]);
  });
});

describe("question marks only for a fixed list of whole safety questions (Sol, 6)", () => {
  it("leaves statements alone", () => {
    expect(holdCrisisLines(["Only after help arrives are you safe."])[1]).toBe("Only after help arrives are you safe.");
    expect(holdCrisisLines(["Solo si estás lejos de él, estás a salvo."], CRISIS_LINE_ES)[1]).toBe("Solo si estás lejos de él, estás a salvo.");
  });

  it("restores the marks on a whole safety question from the list", () => {
    expect(holdCrisisLines(["I'm here with you. are you safe right now"])[1]).toBe("I'm here with you. are you safe right now?");
    expect(holdCrisisLines(["is anyone with you"])[1]).toBe("is anyone with you?");
    expect(holdCrisisLines(["Estoy aquí contigo. estás a salvo ahora"], CRISIS_LINE_ES)[1]).toBe("Estoy aquí contigo. ¿estás a salvo ahora?");
    expect(holdCrisisLines(["hay alguien contigo"], CRISIS_LINE_ES)[1]).toBe("¿hay alguien contigo?");
  });
});
