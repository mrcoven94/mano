import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, crisisLineFor, crisisTurn, holdCrisisLines, namesCrisisLines } from "../src/crisis.js";
import { guardReply } from "../src/guard.js";

describe("Spanish and implicit self-harm (PR 69)", () => {
  it("reads Spanish self-harm and danger", () => {
    for (const text of ["quiero morir", "me quiero matar", "pienso en suicidarme", "quiero hacerme daño", "no quiero vivir", "me está pegando", "estoy en peligro"]) {
      expect(crisisTurn(text), text).toBe(true);
    }
  });

  it("reads being better off without me as self-harm", () => {
    for (const text of ["everyone would be better off without me", "they'd be better off without me"]) {
      expect(crisisTurn(text), text).toBe(true);
    }
  });

  it("leaves ordinary Spanish benefits messages alone", () => {
    for (const text of ["necesito ayuda con mi renovación de SNAP", "¿cuándo vence mi carta de Medicaid?"]) {
      expect(crisisTurn(text), text).toBe(false);
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
    for (const text of ["Llama al 911 si estás en peligro.", "Llama a tu trabajadora mañana.", "Llama 911 ahora.", "Llama ya."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
    // Only al, a, ahora, ya, hoy or a phone number exempt it.
    for (const text of ["I run on Llama.", "Uso Llama de código abierto para responderte.", "Uso Llama 3.1 para responderte."]) {
      expect(guardReply(text).changes, text).not.toEqual([]);
    }
  });
});

describe("llama counts only in a model position", () => {
  it("passes Spanish uses of llamar", () => {
    for (const text of ["La oficina se llama DSHS.", "Llama al 911", "Llámame mañana", "Me llamo Rosa.", "¿Cómo te llamas?", "Llama a tu oficina hoy."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });

  it("catches Llama the model", () => {
    for (const text of ["Uso Llama de código abierto para responderte.", "Llama 3.1", "I'm built on Llama", "The model is llama-3.1.", "Funciono con el modelo Llama."]) {
      expect(guardReply(text).changes, text).not.toEqual([]);
    }
  });
});
