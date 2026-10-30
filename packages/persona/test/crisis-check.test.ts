// Sol's third review of PR 77 and the lead's design: the keyword detector
// is the recall floor. Only when it says crisis AND the message is one
// short health question does a model get one question, and only an exact
// "no" exempts. Everything else, including errors and timeouts, is a crisis.
import { describe, expect, it } from "vitest";
import { CRISIS_LINE, CRISIS_LINE_ES, crisisTurn, decideCrisis, holdCrisisLines, isOneHealthQuestion, type CrisisCheck } from "../src/crisis.js";

const answers = (answer: string | (() => Promise<string>)): CrisisCheck & { calls: number } => {
  const check = {
    live: true,
    calls: 0,
    async ask(): Promise<string> {
      check.calls += 1;
      return typeof answer === "string" ? answer : answer();
    },
  };
  return check;
};

const QUESTION = "Should I stop taking my blood pressure pills?";

describe("decideCrisis: only an exact no exempts", () => {
  it("exempts a one-question health message the model answers no", async () => {
    expect(await decideCrisis(QUESTION, answers("no"))).toMatchObject({ crisis: false, reason: "model-no" });
  });

  for (const [label, answer] of [
    ["yes", "yes"],
    ["No. with a period", "No."],
    ["capital No", "No"],
    ["garbage", "I am not sure, maybe"],
    ["empty", ""],
  ] as const) {
    it(`keeps the crisis line when the model answers ${label}`, async () => {
      expect(await decideCrisis(QUESTION, answers(answer))).toMatchObject({ crisis: true });
    });
  }

  it("keeps the crisis line when the check throws", async () => {
    expect(await decideCrisis(QUESTION, answers(async () => { throw new Error("down"); }))).toMatchObject({ crisis: true, reason: "check-error" });
  });

  it("keeps the crisis line when the check is slower than the timeout", async () => {
    const slow = answers(() => new Promise((r) => setTimeout(() => r("no"), 200)));
    expect(await decideCrisis(QUESTION, slow, { timeoutMs: 20 })).toMatchObject({ crisis: true, reason: "check-timeout" });
  });

  it("keeps the crisis line with no check, or a check that is not live", async () => {
    expect(await decideCrisis(QUESTION, null)).toMatchObject({ crisis: true, reason: "no-check" });
    expect(await decideCrisis(QUESTION, { live: false, ask: async () => "no" })).toMatchObject({ crisis: true, reason: "no-check" });
  });

  it("never asks the model when the floor says no crisis, or when it is not one health question", async () => {
    const check = answers("no");
    expect(await decideCrisis("What documents do I need for WIC?", check)).toMatchObject({ crisis: false, reason: "floor" });
    expect(await decideCrisis("I hurt my back at work, can I get disability?", check)).toMatchObject({ crisis: true, reason: "floor" });
    expect(check.calls).toBe(0);
  });

  it("uses the keyword floor alone in crisisTurn, with no exemption", () => {
    expect(crisisTurn(QUESTION)).toBe(true);
    expect(isOneHealthQuestion(QUESTION)).toBe(true);
  });
});

describe("Sol's third-review questions reach the model, and stay crisis on yes", () => {
  for (const text of [
    "Can I hurt my arm intentionally?",
    "How can I hurt my arm without anyone noticing?",
    "Can I take my heart pills forty at a time?",
    "Is it bad if I take my heart pills by the handful?",
    "Should I stop taking my heart pills since life is not worth living?",
    "¿Puedo dejar mis heart pills si no tengo ganas de vivir?",
  ]) {
    it(`"${text}"`, async () => {
      expect(await decideCrisis(text, answers("yes"))).toMatchObject({ crisis: true });
      expect(await decideCrisis(text, null)).toMatchObject({ crisis: true });
    });
  }
});

describe("sleeping and not waking up (main misses these too)", () => {
  for (const text of ["quiero dormir y no despertar", "tomé pastillas para no despertar", "me voy a dormir y no despertar nunca"]) {
    it(`"${text}" is a crisis`, () => {
      expect(crisisTurn(text)).toBe(true);
    });
  }
});

describe("dedupe matches number and action as a pair (Sol's third review, 4)", () => {
  it("keeps 'text 911' under the Spanish line, which only says to call 911", () => {
    expect(holdCrisisLines(["Si estás en peligro, envía un mensaje al 911."], CRISIS_LINE_ES)).toEqual([CRISIS_LINE_ES, "Si estás en peligro, envía un mensaje al 911."]);
  });

  it("still drops an exact pair repeat", () => {
    expect(holdCrisisLines(["Si estás en peligro, llama al 911."], CRISIS_LINE_ES)).toEqual([CRISIS_LINE_ES]);
    expect(holdCrisisLines(["Call or text 988 now.", "If you're in danger right now, call 911."])).toEqual([CRISIS_LINE]);
  });
});

describe("question marks only where there is no closing punctuation (Sol's third review, 5)", () => {
  it("leaves a sentence that ends in a period as written", () => {
    expect(holdCrisisLines(["Hay alguien contigo."], CRISIS_LINE_ES)[1]).toBe("Hay alguien contigo.");
    expect(holdCrisisLines(["Estás a salvo."], CRISIS_LINE_ES)[1]).toBe("Estás a salvo.");
    expect(holdCrisisLines(["You are safe now. are you safe right now."])[1]).toBe("You are safe now. are you safe right now.");
  });

  it("restores the marks on a listed safety question with no closing punctuation", () => {
    expect(holdCrisisLines(["hay alguien contigo"], CRISIS_LINE_ES)[1]).toBe("¿hay alguien contigo?");
    expect(holdCrisisLines(["I'm here. are you safe right now"])[1]).toBe("I'm here. are you safe right now?");
  });
});

describe("the model check's time limit", () => {
  it("is 3 seconds", async () => {
    const { CRISIS_CHECK_TIMEOUT_MS } = await import("../src/crisis.js");
    expect(CRISIS_CHECK_TIMEOUT_MS).toBe(3000);
  });
});
