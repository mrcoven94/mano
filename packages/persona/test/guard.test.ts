import { describe, expect, it } from "vitest";
import { SAFE_REPLY, SELF_DESCRIPTION, containsProviderName, guardReply } from "../src/guard.js";

describe("guardReply dashes", () => {
  it("turns em and en dashes between words into a comma", () => {
    expect(guardReply("Call them first — today if you can.").text).toBe("Call them first, today if you can.");
    expect(guardReply("Call them first–today.").text).toBe("Call them first, today.");
    expect(guardReply("Call them first—today.").changes).toEqual(["dash"]);
  });

  it("rewrites spaced hyphens and double hyphens used as dashes", () => {
    expect(guardReply("Bring your ID - and the letter.").text).toBe("Bring your ID, and the letter.");
    expect(guardReply("Bring your ID -- and the letter.").text).toBe("Bring your ID, and the letter.");
  });

  it("reads number ranges as words", () => {
    expect(guardReply("It takes 7–10 days.").text).toBe("It takes 7 to 10 days.");
    expect(guardReply("It takes 7 - 10 days.").text).toBe("It takes 7 to 10 days.");
  });

  it("leaves no stray comma at an edge and keeps hyphenated words and numbers", () => {
    expect(guardReply("— Hey there —").text).toBe("Hey there");
    expect(guardReply("Call 1-800-555-0100 about your follow-up.")).toEqual({
      text: "Call 1-800-555-0100 about your follow-up.",
      changes: [],
    });
  });
});

describe("guardReply markdown", () => {
  it("drops bold, italics, headers and code marks, keeping the words", () => {
    expect(guardReply("**Good news:** you *likely* qualify.").text).toBe("Good news: you likely qualify.");
    expect(guardReply("## Next steps\nCall the office.").text).toBe("Next steps.\nCall the office.");
    expect(guardReply("Use the `Renew` button.").text).toBe("Use the Renew button.");
  });

  it("turns a bullet list into sentences on one line, one bubble (voice v2)", () => {
    expect(guardReply("- Bring your ID\n* Bring the letter.\n• Ask for a receipt").text).toBe(
      "Bring your ID. Bring the letter. Ask for a receipt.",
    );
  });

  it("keeps link targets so the link check still sees them", () => {
    expect(guardReply("Apply at [the portal](https://example.gov/apply).").text).toBe("Apply at the portal (https://example.gov/apply).");
    expect(guardReply("Go to [example.gov](https://example.gov).").text).toBe("Go to https://example.gov.");
  });

  it("leaves snake_case, URLs and math alone", () => {
    const text = "See https://example.gov/a_b_c and 5 * 3 = 15.";
    expect(guardReply(text)).toEqual({ text, changes: [] });
  });
});

describe("guardReply model and provider names", () => {
  it("replaces a self-description with Mano's own", () => {
    expect(guardReply("I'm Muse Spark! How can I help?")).toEqual({
      text: `${SELF_DESCRIPTION} How can I help?`,
      changes: ["self-description"],
    });
    expect(guardReply("I'm ChatGPT, made by OpenAI.").text).toBe(SELF_DESCRIPTION);
    expect(guardReply("I am a large language model built by Meta. I can help with forms.").text).toBe(
      `${SELF_DESCRIPTION} I can help with forms.`,
    );
  });

  it("replaces the self-description once and drops other sentences that name a provider", () => {
    expect(guardReply("I'm Muse. I run on Llama. Meta trained me. What's up?").text).toBe(`${SELF_DESCRIPTION} What's up?`);
    expect(guardReply("Unlike Llama, this one is free. Bring the letter.")).toEqual({
      text: "Bring the letter.",
      changes: ["provider-name"],
    });
  });

  it("does not flag ordinary words", () => {
    for (const text of ["The museum is closed.", "A spark of hope.", "Check your metadata.", "Llamas are calm.", "Let me muse on it."]) {
      expect(containsProviderName(text)).toBe(false);
      expect(guardReply(text).changes).toEqual([]);
    }
  });
});

describe("guardReply empty and unsendable replies", () => {
  it("never returns empty text", () => {
    for (const raw of ["", "   ", "\n\n", "**", "—", "DEEP:", "- ", "I'm GPT."]) {
      const { text } = guardReply(raw);
      expect(text.trim().length).toBeGreaterThan(0);
    }
    expect(guardReply("")).toEqual({ text: SAFE_REPLY, changes: ["empty"] });
    expect(guardReply("**")).toEqual({ text: SAFE_REPLY, changes: ["markdown", "empty"] });
    expect(guardReply("Muse.")).toEqual({ text: SAFE_REPLY, changes: ["provider-name", "empty"] });
  });

  it("strips a leaked routing marker anywhere", () => {
    expect(guardReply("DEEP: Let me check Ohio's numbers.")).toEqual({
      text: "Let me check Ohio's numbers.",
      changes: ["route-marker"],
    });
    expect(guardReply("I'll dig in.DEEP: One sec.").text).toBe("I'll dig in. One sec.");
  });

  it("writes its own lines in the voice it enforces", () => {
    for (const line of [SAFE_REPLY, SELF_DESCRIPTION]) {
      expect(guardReply(line)).toEqual({ text: line, changes: [] });
    }
  });
});

describe("guardReply idempotence", () => {
  it("returns the same text when run twice, so replays send the same bytes", () => {
    const corpus = [
      "I'm Muse Spark! — your assistant",
      "**Steps:**\n- Call — today\n- Bring 2–3 pay stubs",
      "## Hi\n> quoted — text\n---\nI'm Claude, by Anthropic.",
      "Apply at [the portal](https://example.gov/apply) -- soon.",
      "",
    ];
    for (const raw of corpus) {
      const once = guardReply(raw).text;
      expect(guardReply(once)).toEqual({ text: once, changes: [] });
    }
  });
});

describe("guardReply real model identifiers (review blocker 4)", () => {
  it("catches model IDs and names in any case", () => {
    expect(guardReply("I am muse-spark-1.3.").text).toBe(SELF_DESCRIPTION);
    expect(guardReply("I use META for answers.").text).toBe(SELF_DESCRIPTION);
    expect(guardReply("i'm muse spark lol").text).toBe(SELF_DESCRIPTION);
    expect(guardReply("i use meta for answers").text).toBe(SELF_DESCRIPTION);
    expect(guardReply("Running on llama3 today. Bring the letter.").text).toBe(`${SELF_DESCRIPTION} Bring the letter.`);
  });

  it("catches the configured model IDs", () => {
    expect(containsProviderName("I run on acme-reply-7.", ["acme-reply-7"])).toBe(true);
    expect(guardReply("I run on acme-reply-7.", { modelIds: ["acme-reply-7-contributor"] }).text).toBe(SELF_DESCRIPTION);
  });

  it("still passes ordinary words used as words", () => {
    for (const text of ["A spark of hope.", "Let me muse on it.", "Check your metadata.", "Llamas are calm."]) {
      expect(guardReply(text).changes, text).toEqual([]);
    }
  });
});

describe("guardReply lowercase identity statements (review round 2, blocker 2)", () => {
  it("catches direct identity and provider statements with lowercase names", () => {
    for (const text of ["My provider is meta.", "I am meta.", "I am muse glimmer."]) {
      expect(containsProviderName(text), text).toBe(true);
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
    expect(containsProviderName("i run on llama")).toBe(true);
    expect(containsProviderName("built by meta")).toBe(true);
    expect(containsProviderName("powered by muse")).toBe(true);
  });

});

describe("guardReply keeps sentence boundaries (review round 2, blocker 1)", () => {
  it("is idempotent when it drops a sentence between lines", () => {
    const once = guardReply("There is a spark of hope\nUnlike Gemini, it costs nothing.\nI use this to help you.").text;
    expect(guardReply(once)).toEqual({ text: once, changes: [] });
  });
});

describe("provider and model names leak in any case (review round 3, blocker 2)", () => {
  it("replaces or drops every sentence that names one, however it is introduced", () => {
    for (const text of ["My name is meta.", "You're chatting with muse glimmer.", "I'm an assistant from meta."]) {
      expect(containsProviderName(text), text).toBe(true);
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
    expect(guardReply("Ask Llama about it. Bring the letter.").text).toBe("Bring the letter.");
    expect(guardReply("Use Muse for that. Bring the letter.").text).toBe("Bring the letter.");
  });

  it("passes only the allowlisted ordinary phrases", () => {
    for (const text of ["There is a spark of hope.", "Let me muse on it.", "We'll muse about it.", "A glimmer of hope."]) {
      expect(containsProviderName(text), text).toBe(false);
      expect(guardReply(text).changes, text).toEqual([]);
    }
  });
});

describe("identity statements beat the allowlist (review round 4, blocker 2)", () => {
  it("counts an identity statement with any name as a leak", () => {
    for (const text of ["I'm powered by the spark model.", "I'm powered by the glimmer model.", "My name is the Spark."]) {
      expect(containsProviderName(text), text).toBe(true);
      expect(guardReply(text).text, text).toBe(SELF_DESCRIPTION);
    }
  });

  it("catches the configured ID and model IDs written with spaces", () => {
    expect(containsProviderName("Powered by the spark 1.3 model.")).toBe(true);
    expect(containsProviderName("I run on the muse spark 1.3 thing.", ["muse-spark-1.3"])).toBe(true);
  });

  it("keeps only the exact idioms", () => {
    for (const text of ["There is a spark of hope.", "A glimmer of hope.", "Let me muse on it.", "We can muse about it later."]) {
      expect(guardReply(text).changes, text).toEqual([]);
    }
    for (const text of ["I see a glimmer."]) {
      expect(containsProviderName(text), text).toBe(true);
    }
  });
});

describe("a leaked speaker label (Quality chat-oh-03, chat-wa-03)", () => {
  it("strips Mano: at the start of a line and keeps the name elsewhere", () => {
    expect(guardReply("usually proof of income and rent\nMano: which state is your SNAP in?")).toEqual({
      text: "usually proof of income and rent\nwhich state is your SNAP in?",
      changes: ["speaker-label"],
    });
    expect(guardReply("Mano: hey!").text).toBe("hey!");
    expect(guardReply("I'm Mano: I help with benefits")).toEqual({ text: "I'm Mano: I help with benefits", changes: [] });
  });
});
