import { describe, expect, it } from "vitest";
import { SELF_DESCRIPTION, containsProviderName, guardReply } from "../src/guard.js";
import { isCrisis, mightBeCrisis } from "../src/crisis.js";
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
    expect(guardReply("1. Call the office\n2) Bring your ID").text).toBe("Call the office.\nBring your ID.");
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
    for (const text of ["This is Nova, your assistant.", "This is Google Assistant speaking."]) {
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });
});

describe("PR 67 review round 2", () => {
  it("replaces self-references naming a listed company or assistant, in any case (blocker 1)", () => {
    for (const text of [
      "This is Google Assistant. How can I help?",
      "this is google assistant",
      "I'm Alexa.",
      "My maker is Amazon.",
      "You're talking with Copilot from Microsoft.",
      "I am built on xAI's Grok.",
      "This is Nova.",
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
