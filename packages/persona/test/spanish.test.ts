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

describe("Llama versions look like model versions (final round)", () => {
  it("catches model versions", () => {
    for (const text of ["Llama 3", "Llama 3.1", "I run llama-3.1-8b", "Llama3 answers here", "Uso Llama 3.1-instruct."]) {
      expect(guardReply(text).changes, text).not.toEqual([]);
    }
  });

  it("passes times, durations and phone numbers", () => {
    for (const text of ["Llama 24 horas antes de tu entrevista de SNAP.", "Llama 1-800-555-0100", "Llama 2 días antes.", "Llama 3 hours before."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });
});

describe("boundaries after accented letters", () => {
  it("catches Llama identities that end in an accented letter", () => {
    for (const text of ["Llama me creó.", "Llama me entrenó."]) {
      expect(guardReply(text).changes, text).not.toEqual([]);
    }
  });

  it("reads Spanish crisis phrases that end in accented letters", async () => {
    const { crisisTurn } = await import("../src/crisis.js");
    for (const text of ["quiero hacerme daño", "me quiero matar ya", "voy a suicidarme así", "estoy en peligro aquí"]) {
      expect(crisisTurn(text), text).toBe(true);
    }
  });
});

describe("the crisis floor in Vietnamese and Tagalog", () => {
  it.each([
    // Self-harm.
    "tôi muốn tự tử", "To\u0302i muo\u0302\u0301n chết", "tôi không muốn sống nữa", "tôi chán sống rồi", "tôi muốn tự làm hại mình", "toi muon chet", "toi muon tu tu", "toi khong muon song nua",
    "Papatayin ko ang sarili ko", "Gusto ko nang mamatay", "gusto kong mamatay", "magpapakamatay ako", "ayoko nang mabuhay", "sasaktan ko ang sarili ko", "gusto ko nang maglaslas",
    // Being hit or threatened.
    "Chồng tôi đang đánh tôi", "chồng tôi đánh tôi", "tôi bị đánh", "anh ấy dọa giết tôi", "tôi bị bạo hành", "chong toi dang danh toi",
    "binubugbog ako ng asawa ko", "binubugbog niya ako", "sinasaktan ako ng asawa ko", "sinuntok niya ako", "papatayin niya ako", "sinasakal niya ako",
    // Immediate danger.
    "Tôi đang gặp nguy hiểm", "tôi không an toàn", "cứu tôi với", "toi dang gap nguy hiem",
    "nasa panganib ako", "hindi ako ligtas", "nanganganib ang buhay ko", "saklolo",
  ])("%j is a crisis, and names 988 and 911", (text) => {
    expect(crisisTurn(text)).toBe(true);
    expect(crisisLineFor(text)).toMatch(/988/);
    expect(crisisLineFor(text)).toMatch(/911/);
  });

  // Ordinary benefit messages, and the look-alikes the phrases must leave alone.
  it.each([
    "Tôi cần giúp đỡ về phiếu thực phẩm", "tôi muốn gia hạn phúc lợi", "từ từ thôi", "tu tu thoi", "đánh thức tôi lúc 7 giờ", "khoản này bị đánh thuế", "chồng tôi đánh máy đơn", "bí danh của tôi", "bi danh cua toi",
    "Kailangan ko ng tulong para sa pagkain po", "Ano ang gagawin ko sa sulat na ito", "Hindi ako sigurado", "tulungan mo ako sa form", "nawala ang benepisyo ko", "ang sarili kong bahay",
  ])("%j is not", (text) => {
    expect(crisisTurn(text)).toBe(false);
  });
});
