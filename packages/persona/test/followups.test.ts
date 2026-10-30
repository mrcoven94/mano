import { describe, expect, it } from "vitest";
import { SELF_DESCRIPTION, containsProviderName, guardReply } from "../src/guard.js";
import { CRISIS_LINE, holdCrisisLines, isCrisis, mightBeCrisis } from "../src/crisis.js";
import { PROBES } from "../src/probes.js";

describe("self-identity is a class (follow-up 2)", () => {
  it("replaces any self-identification that does not name Mano, whatever the name", () => {
    for (const text of [
      "I was developed by Google.",
      "I am an assistant powered by Microsoft.",
      "I am Amazon Nova.",
      "I'm Acme Helper, here to help.",
      "My name is Robin.",
      "I was trained by a big lab.",
    ]) {
      expect(containsProviderName(text), text).toBe(true);
      expect(guardReply(text).text.startsWith(SELF_DESCRIPTION), text).toBe(true);
    }
  });

  it("leaves Mano's own self-description and ordinary first-person sentences alone", () => {
    for (const text of [
      SELF_DESCRIPTION,
      "I'm Mano. It means hand.",
      "My name is Mano.",
      "I'm an assistant, not a person.",
      "I'm here with you.",
      "I'm sorry that happened.",
      "I was going to ask what the letter says.",
    ]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });
});

describe("numbered lists and strikethrough (should 8)", () => {
  it("normalizes both", () => {
    expect(guardReply("1. Call the office\n2) Bring your ID").text).toBe("Call the office. Bring your ID.");
    expect(guardReply("The deadline is ~~March 1~~ March 3.").text).toBe("The deadline is March 1 March 3.");
  });

  it("leaves years and amounts at a line start alone", () => {
    for (const text of ["2025 was a hard year.", "2026. That is when it renews.", "$400. That is the estimate."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });
});

describe("the broad crisis check covers self-harm methods (follow-up 1)", () => {
  it("matches overdose, pills, hanging, cutting and ending it", () => {
    for (const text of [
      "I took a whole bottle of pills",
      "I plan to hang myself tonight",
      "thinking about an overdose",
      "I want to end it",
      "I don't want to live anymore",
      "I cut myself",
    ]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
    expect(isCrisis("I plan to hang myself tonight")).toBe(true);
    expect(isCrisis("I took a whole bottle of pills")).toBe(true);
  });
});

describe("follow-up probes", () => {
  it("carries Sol's self-harm messages as crisis probes", () => {
    for (const id of ["pills", "hang"]) expect(PROBES.find((p) => p.id === id)?.kind, id).toBe("crisis");
  });
});

describe("PR 67 review", () => {
  it("catches contractions, straight and curly (blocker 1)", () => {
    for (const text of ["I'm an assistant powered by Microsoft.", "I'm built by Google.", "I’m built by Google.", "I’m an assistant powered by Microsoft."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });

  it("leaves document, program and place explanations alone (should 3)", () => {
    for (const text of [
      "This is Ohio's food assistance renewal form. Sign page 2.",
      "This is the Medicaid office in Columbus.",
      "This is SNAP, the food program.",
      "This is Franklin County's deadline, not the state's.",
    ]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });

  it("still catches explicit assistant identities that start with This is (should 3)", () => {
    // Round 4 rule 4 retired "this is X" for companies; these now count
    // only through a first-person identity or a maker clause.
    for (const text of ["I'm Nova, your assistant.", "I'm Google Assistant.", "I'm ChatGPT, made by OpenAI."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });
});

describe("PR 67 review round 2", () => {
  it("replaces self-references naming a listed company or assistant, in any case (blocker 1)", () => {
    for (const text of [
      "I'm Google Assistant. How can I help?",
      "i'm google assistant",
      "I'm Alexa.",
      "My maker is Amazon.",
      "I am built on xAI's Grok.",
    ]) {
      expect(containsProviderName(text), text).toBe(true);
      expect(guardReply(text).text.startsWith(SELF_DESCRIPTION), text).toBe(true);
    }
  });

  it("keeps Washington's Apple Health program name", () => {
    const text = "I can help you renew Apple Health.";
    expect(guardReply(text), text).toEqual({ text, changes: [] });
  });

  it("applies the maker rule only to the assistant itself (regression 2)", () => {
    for (const text of ["I'm reviewing a renewal form created by the county. Sign page 2.", "I was looking at a letter made by DSHS."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
    for (const text of ["I was created by Acme.", "I'm built by Acme Labs.", "I'm an assistant made by Acme."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });

  it("needs a harm signal plus a substance for an overdose (regression 3)", () => {
    for (const text of ["I took a bottle of water to my SNAP interview.", "I take a bottle of formula to daycare.", "I take my meds every morning."]) {
      expect(isCrisis(text), text).toBe(false);
    }
    for (const text of ["I took a whole bottle of pills", "I swallowed all my meds", "I downed a whole bottle", "I took too many tablets", "thinking about an overdose"]) {
      expect(isCrisis(text), text).toBe(true);
    }
  });
});

describe("listed names count only inside an identity construction (lead decision)", () => {
  it("passes real benefits help that names a company", () => {
    for (const text of [
      "I'd check whether Amazon takes your EBT card.",
      "You can look it up on Google Maps.",
      "Walmart and Amazon accept SNAP online.",
      "If your phone is locked, call Apple support.",
      "I can help you renew Apple Health.",
    ]) {
      expect(containsProviderName(text), text).toBe(false);
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });

  it("replaces an identity construction with a listed name", () => {
    for (const text of ["I use Google to answer.", "Meta made me.", "Google made me.", "I'm based on Amazon Nova.", "I'm Google's assistant."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });
});

describe("model words split in two (lead decision)", () => {
  it("passes people's names and ordinary words outside identity constructions", () => {
    for (const text of ["Your caseworker Claude will call Friday.", "I'm a Gemini.", "There's a nova of options.", "I'm a Medicaid expert, more or less."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });

  it("still replaces those words inside identity constructions", () => {
    for (const text of ["I'm Claude.", "I'm powered by Meta.", "Powered by Meta.", "I'm Gemini, your assistant.", "I'm a Gemini model."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });

  it("keeps our own stack counting anywhere (round 3 narrowed this to muse, glimmer, llama and model IDs)", () => {
    for (const text of ["Ask Llama for help.", "Ask Muse for help.", "The glimmer model can tell you.", "Try gpt-4o."]) {
      expect(containsProviderName(text), text).toBe(true);
    }
  });
});

describe("PR 67 review round 3", () => {
  it("counts meta and spark after a maker or power verb anywhere in the sentence (2b)", () => {
    for (const text of ["I'm Mano, powered by Meta.", "I was built on Spark.", "Mano is made by Meta.", "I'm running on Muse Spark."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });

  it("counts other names only in a first-person identity or a maker clause (2c)", () => {
    for (const text of ["Ask ChatGPT about it.", "Copilot can draft that email.", "You can look it up on Google Maps.", "This is the Amazon Fresh page where you can use your EBT card."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
    for (const text of ["I'm ChatGPT.", "My name is Google.", "I was made by Microsoft.", "Microsoft made me."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });
});

describe("PR 67 review round 4", () => {
  it("always puts the crisis line first, once (1)", () => {
    expect(holdCrisisLines(["Please call 911 right now."])[0]).toBe(CRISIS_LINE);
    expect(holdCrisisLines(["Call 988 or 911, I'm here."])[0]).toBe(CRISIS_LINE);
    expect(holdCrisisLines([CRISIS_LINE, "I'm here."]).filter((b) => b === CRISIS_LINE)).toHaveLength(1);
  });

  it("widens the broad check (2)", () => {
    for (const text of ["I want to slit my wrists", "I am going to throw myself off a bridge", "I'm going to cut my arm", "I'd be better off dead", "I do not want to be here"]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
  });

  it("counts meta and spark anywhere, outside the idioms (3)", () => {
    for (const text of ["I'm Mano, Meta's assistant.", "You're talking with Spark.", "Ask Meta about it."]) {
      expect(containsProviderName(text), text).toBe(true);
    }
    for (const text of ["There is a spark of hope.", "Your caseworker Claude will call Friday."]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });

  it("ignores names inside quotation marks and descriptions of other assistants (4)", () => {
    for (const text of [
      'On the renewal form, write "My name is Maria Garcia" and sign page 2.',
      "On the form, type “I'm Maria” in box 3.",
      "This is the Amazon Fresh page, where a virtual assistant can help you use your EBT card.",
    ]) {
      expect(guardReply(text), text).toEqual({ text, changes: [] });
    }
  });
});

describe("in danger of losing or of being (lead decision)", () => {
  it("is not a crisis for either check, while explicit danger still is", () => {
    for (const text of ["I am in danger of losing my benefits.", "we're in danger of being evicted", "We are in danger of being cut off", "she's in danger of being dropped from Medicaid"]) {
      expect(mightBeCrisis(text), text).toBe(false);
      expect(isCrisis(text), text).toBe(false);
    }
    for (const text of ["I'm in danger", "I am in immediate danger", "I'm not safe"]) {
      expect(mightBeCrisis(text), text).toBe(true);
    }
  });
});
