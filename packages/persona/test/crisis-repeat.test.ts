// safety-05 on the live text line (Quality PR 76): the guaranteed crisis
// line went first, then the model said it again, and once the safety
// question lost its question marks ("estás a salvo en este momento").
import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, holdCrisisLines, namesCrisisLines } from "../src/crisis.js";
import { CRISIS_NOTE, crisisNote } from "../src/crisis.js";

describe("the crisis line is said once (safety-05)", () => {
  it("drops a model sentence that only repeats 988 or 911, and keeps the human part (Spanish)", () => {
    const bubbles = holdCrisisLines(
      ["Me alegra mucho que me lo hayas dicho.", "Por favor llama o manda texto al 988 ahora mismo, es gratis y está abierto 24/7.", "Si estás en peligro ahora mismo, llama al 911. Estoy aquí contigo, ¿estás a salvo en este momento?"],
      CRISIS_LINE_ES,
    );
    expect(bubbles).toEqual([CRISIS_LINE_ES, "Me alegra mucho que me lo hayas dicho.", "Estoy aquí contigo, ¿estás a salvo en este momento?"]);
    expect(bubbles.join(" ").match(/\b988\b/g)).toHaveLength(1);
  });

  it("does the same in English, and keeps the line naming both numbers", () => {
    const bubbles = holdCrisisLines(["I'm really glad you told me. Please call or text 988 right now, it's free and open 24/7", "if you're in danger right now, call 911. I'm here with you. are you safe at this moment?"]);
    // "I'm really glad you told me" is in the line already, so it goes too.
    expect(bubbles).toEqual([CRISIS_LINE, "I'm here with you. are you safe at this moment?"]);
    expect(namesCrisisLines(bubbles.join(" "))).toBe(true);
  });

  it("keeps other help a model adds, like a hotline that is not 988 or 911", () => {
    const bubbles = holdCrisisLines(["You can also call 1-800-799-7233 any time.", "Call 988 now."]);
    expect(bubbles).toEqual([CRISIS_LINE, "You can also call 1-800-799-7233 any time."]);
  });

  it("never drops the guaranteed line, even when every model bubble was a repeat", () => {
    expect(holdCrisisLines(["Call or text 988 now.", "Call 911 if you're in danger."])).toEqual([CRISIS_LINE]);
  });
});

describe("the safety question keeps its question marks (safety-05)", () => {
  it("restores ¿ and ? on a Spanish safety question that lost them", () => {
    expect(holdCrisisLines(["estoy aquí contigo, estás a salvo en este momento"], CRISIS_LINE_ES)).toEqual([
      CRISIS_LINE_ES,
      "estoy aquí contigo, ¿estás a salvo en este momento?",
    ]);
    expect(holdCrisisLines(["¿Estás a salvo ahora mismo"], CRISIS_LINE_ES)[1]).toBe("¿Estás a salvo ahora mismo?");
  });

  it("restores ? on an English safety question that lost it, and leaves a kept one alone", () => {
    expect(holdCrisisLines(["I'm here with you. are you safe right now"])[1]).toBe("I'm here with you. are you safe right now?");
    expect(holdCrisisLines(["are you safe at this moment?"])[1]).toBe("are you safe at this moment?");
    expect(holdCrisisLines(["¿estás a salvo?"], CRISIS_LINE_ES)[1]).toBe("¿estás a salvo?");
  });
});

describe("the model is told the line is already sent", () => {
  it("names the exact line, says not to repeat 988 or 911, and asks for the human part with the question mark", () => {
    expect(crisisNote(CRISIS_LINE_ES)).toContain(CRISIS_LINE_ES);
    expect(CRISIS_NOTE).toMatch(/Do not repeat 988 or 911/);
    expect(CRISIS_NOTE).toMatch(/are you safe right now\?/);
    expect(CRISIS_NOTE).toMatch(/¿estás a salvo ahora mismo\?/);
  });
});

describe("the model's words never repeat what the line already says (live run, English)", () => {
  it("drops a model sentence the line already says, and keeps the rest", () => {
    expect(holdCrisisLines(["I'm really glad you told me", "I'm here with you", "are you safe right now?"])).toEqual([
      CRISIS_LINE,
      "I'm here with you",
      "are you safe right now?",
    ]);
    expect(holdCrisisLines(["i'm really glad you told me.", "are you safe right now?"])).toEqual([CRISIS_LINE, "are you safe right now?"]);
  });

  it("tells the model not to repeat anything the line says, only to add what it leaves out", () => {
    expect(CRISIS_NOTE).toMatch(/Do not repeat anything that line says/);
  });
});
