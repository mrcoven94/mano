import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, crisisLineFor, holdCrisisLines, isCrisis, mightBeCrisis, namesCrisisLines } from "../src/crisis.js";
import { guardReply } from "../src/guard.js";

describe("Spanish and implicit self-harm (PR 69)", () => {
  it("reads Spanish self-harm and danger on both detectors", () => {
    for (const text of ["quiero morir", "me quiero matar", "pienso en suicidarme", "quiero hacerme daño", "no quiero vivir", "me está pegando", "estoy en peligro"]) {
      expect(mightBeCrisis(text), text).toBe(true);
      expect(isCrisis(text), text).toBe(true);
    }
  });

  it("reads being better off without me as self-harm on both detectors", () => {
    for (const text of ["everyone would be better off without me", "they'd be better off without me"]) {
      expect(mightBeCrisis(text), text).toBe(true);
      expect(isCrisis(text), text).toBe(true);
    }
  });

  it("leaves ordinary Spanish benefits messages alone", () => {
    for (const text of ["necesito ayuda con mi renovación de SNAP", "¿cuándo vence mi carta de Medicaid?"]) {
      expect(mightBeCrisis(text), text).toBe(false);
    }
  });
});

describe("the crisis line in Spanish", () => {
  it("is the approved Spanish line, names both numbers and passes the guard", () => {
    expect(CRISIS_LINE_ES).toBe("Si estás en peligro o piensas en hacerte daño, llama al 911 o envía un mensaje al 988.");
    expect(namesCrisisLines(CRISIS_LINE_ES)).toBe(true);
    expect(guardReply(CRISIS_LINE_ES)).toEqual({ text: CRISIS_LINE_ES, changes: [] });
  });

  it("goes first for a Spanish message and the English line otherwise", () => {
    expect(crisisLineFor("quiero morir, no puedo más")).toBe(CRISIS_LINE_ES);
    expect(crisisLineFor("I want to die")).toBe(CRISIS_LINE);
    expect(holdCrisisLines(["Estoy aquí contigo."], CRISIS_LINE_ES)).toEqual([CRISIS_LINE_ES, "Estoy aquí contigo."]);
  });
});

describe("Spanish llama is a verb", () => {
  it("keeps llama as call in Spanish, and still catches Llama the model", () => {
    for (const text of ["Llama al 911 si estás en peligro.", "La oficina se llama DSHS.", "Llama a tu trabajadora mañana."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
    expect(guardReply("I run on Llama.").changes).not.toEqual([]);
  });
});
