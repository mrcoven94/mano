import { describe, expect, it } from "vitest";
import { guardReply } from "../src/guard.js";
import { MANO_SOUL } from "../src/soul.js";
import { EYES, allowedReactions, allowedTapback, eyesAllowed, isReactionText, normalizeQuotes, splitTapback } from "../src/tapbacks.js";
import { REACTION_PROBES, checkReactionSet, type ReactionRun } from "../src/probes.js";

describe("emoji reactions (LAP-508 dynamic tapbacks)", () => {
  it("reads an emoji REACT: line, and maps the native emoji to their tapbacks", () => {
    expect(splitTapback("REACT: 🙏\nanytime")).toEqual({ tapback: "🙏", text: "anytime" });
    expect(splitTapback("REACT: 💪")).toEqual({ tapback: "💪", text: "" });
    expect(splitTapback("REACT: 🎉\nnice")).toEqual({ tapback: "🎉", text: "nice" });
    expect(splitTapback("REACT: ❤️")).toEqual({ tapback: "love", text: "" });
    expect(splitTapback("REACT: 😂\nha")).toEqual({ tapback: "laugh", text: "ha" });
    expect(splitTapback("REACT: 👍")).toEqual({ tapback: "like", text: "" });
    expect(splitTapback("REACT: ‼️\nnoted")).toEqual({ tapback: "emphasize", text: "noted" });
    expect(splitTapback("REACT: 🙏🏽")).toEqual({ tapback: "🙏", text: "" });
  });

  it("never lets the model send the eyes, which only the worker sends", () => {
    expect(splitTapback(`REACT: ${EYES}\nlooking`)).toEqual({ tapback: null, text: "looking" });
    expect(splitTapback("REACT: 🦄\nok")).toEqual({ tapback: null, text: "ok" });
  });

  it("strips a leaked emoji REACT: marker", () => {
    expect(guardReply("ok\nREACT: 🙏").text).toBe("ok");
  });

  it("puts no reaction at all on bad news (PR 74 review, should 4)", () => {
    for (const t of ["love", "laugh", "💪", "🎉", "like", "emphasize", "🙏"] as const) {
      expect(allowedTapback(t, "they denied my medicaid", false), t).toBeNull();
    }
    expect(allowedTapback("💪", "mailed it", false)).toBe("💪");
  });

  it("decides the allowed reactions from the message's own text (PR 74 review 2)", () => {
    expect(allowedReactions("thank you so much", false)).toEqual(["love", "🙏"]);
    expect(allowedReactions("gracias", false)).toEqual(["love", "🙏"]);
    expect(allowedReactions("mailed it", false)).toEqual(["💪", "🎉"]);
    expect(allowedReactions("lo hice!", false)).toEqual(["💪", "🎉"]);
    expect(allowedReactions("jajaja", false)).toEqual(["laugh"]);
    expect(allowedReactions("ok", false)).toEqual(["like"]);
    expect(allowedReactions("got it", false)).toEqual(["💪", "🎉", "like"]);
    for (const text of ["I got fired", "me negaron Medicaid", "thanks, they denied it", "I haven't mailed it", "no lo hice", "my renewal letter came", "can you look at my case"]) {
      expect(allowedReactions(text, false), text).toEqual([]);
    }
    expect(allowedReactions("thank you", true)).toEqual([]);
    expect(eyesAllowed("can you look at my case", false)).toBe(true);
    expect(eyesAllowed("I got fired", false)).toBe(false);
    expect(eyesAllowed("Loved \u201cok\u201d", false)).toBe(false);
  });

  it("allows a reaction only on a short pure form (PR 74 review 4)", () => {
    for (const [text, allowed] of [
      ["thanks!!", ["love", "🙏"]],
      ["thank you so much", ["love", "🙏"]],
      ["Thanks Mano 🙏", ["love", "🙏"]],
      ["ok sounds good", ["like"]],
      ["done, mailed it", ["💪", "🎉"]],
      ["lol", ["laugh"]],
      ["jajaja", ["laugh"]],
      ["😂😂", ["laugh"]],
      ["gracias!", ["love", "🙏"]],
    ] as const) {
      expect(allowedReactions(text, false), text).toEqual(allowed);
    }
    for (const text of ["thanks, my benefits expired", "thanks, I'm homeless", "thank you, the shelter is full tonight", "ok, my car got towed", "thanks for the help with the form yesterday", "lol my landlord", "thank you thank you thank you so much guys"]) {
      expect(allowedReactions(text, false), text).toEqual([]);
    }
  });

  it("counts purely positive thanks as thanks, still short and still vetoed (lead, after review 4)", () => {
    for (const text of ["that helped", "thanks, that helped a lot", "helped a lot!", "you're the best", "you\u2019re the best!", "you rock", "appreciate it", "life saver", "lifesaver!!", "amazing", "perfect, thanks", "gracias por todo", "eres lo máximo"]) {
      expect(allowedReactions(text, false), text).toContain("love");
    }
    for (const text of ["thanks, that helped but they still denied me", "you're the best but my benefits expired", "amazing, they cut my hours"]) {
      expect(allowedReactions(text, false), text).toEqual([]);
    }
  });

  it("reads curly apostrophes as straight ones, and vetoes the wider bad-news list (PR 74 review 3)", () => {
    expect(normalizeQuotes("can\u2019t \u201cok\u201d")).toBe(`can't "ok"`);
    for (const text of ["thanks, my benefits were reduced", "thanks, I can\u2019t pay rent", "thank you, I don\u2019t have food", "ok, it's overdue", "thanks, no money left", "gracias, me redujeron los beneficios", "gracias, no tengo comida", "ok, estoy atrasado"]) {
      expect(allowedReactions(text, false), text).toEqual([]);
    }
  });

  it("never reacts on a crisis turn or on a reaction sent as text", () => {
    expect(allowedTapback("🙏", "thank you", true)).toBeNull();
    for (const text of ["Loved “your renewal is due Friday”", 'Liked "ok"', "Laughed at “fax machines”", "Reacted 👍 to “ok”", "Le encantó “gracias”"]) {
      expect(isReactionText(text), text).toBe(true);
      expect(allowedTapback("love", text, false), text).toBeNull();
    }
    expect(isReactionText("loved it, thanks")).toBe(false);
  });

  it("tells the model to vary reactions and never react instead of answering", () => {
    expect(MANO_SOUL).toContain("REACT: 🙏");
    expect(MANO_SOUL).toMatch(/not to every message/);
    expect(MANO_SOUL).toMatch(/never replaces an answer/);
  });
});

describe("the 20-message reaction set", () => {
  const runOf = (id: string, tapback: ReactionRun["tapback"], reply = "ok"): ReactionRun => ({ id, tapback, reply });
  const calm = (): ReactionRun[] => REACTION_PROBES.map((p) => runOf(p.id, null, "ok"));

  it("has 20 messages covering thanks, jokes, deadlines, done, bad news, questions, a crisis and a reaction", () => {
    expect(REACTION_PROBES).toHaveLength(20);
    const kinds = new Set(REACTION_PROBES.map((p) => p.kind));
    for (const k of ["thanks", "joke", "deadline", "done", "good-news", "bad-news", "question", "crisis", "reaction"]) expect(kinds, k).toContain(k);
  });

  it("fails a set that reacts to every message, or always the same way", () => {
    const all = REACTION_PROBES.map((p) => runOf(p.id, "like"));
    expect(checkReactionSet(all)).toContain("reacts-to-everything");
    expect(checkReactionSet(all)).toContain("no-variety");
  });

  it("fails a heart on bad news, any reaction in a crisis or on a reaction, and a reaction instead of an answer", () => {
    const runs = calm();
    const set = (kind: string, tapback: ReactionRun["tapback"], reply = "ok") => {
      const i = REACTION_PROBES.findIndex((p) => p.kind === kind);
      runs[i] = runOf(REACTION_PROBES[i]!.id, tapback, reply);
      return REACTION_PROBES[i]!.id;
    };
    const bad = set("bad-news", "🙏");
    const crisis = set("crisis", "🙏", "please call or text 988");
    const reaction = set("reaction", "like");
    const question = set("question", null, "");
    const failed = checkReactionSet(runs);
    expect(failed).toContain(`${bad}:bad-news-reaction`);
    expect(failed).toContain(`${crisis}:crisis-reaction`);
    expect(failed).toContain(`${reaction}:reaction-on-reaction`);
    expect(failed).toContain(`${question}:no-words`);
  });

  it("passes a varied, sparing set", () => {
    const runs = calm();
    const pick: Record<string, [ReactionRun["tapback"], string]> = {
      thanks: ["love", "anytime!"],
      joke: ["laugh", "ha, right?"],
      done: ["💪", "nice, that's off your plate"],
      "good-news": ["🎉", "that's huge"],
    };
    for (const [kind, [tapback, reply]] of Object.entries(pick)) {
      const i = REACTION_PROBES.findIndex((p) => p.kind === kind);
      runs[i] = runOf(REACTION_PROBES[i]!.id, tapback, reply);
    }
    expect(checkReactionSet(runs)).toEqual([]);
  });

  it("fails a reaction outside the message's allowed set", () => {
    const runs = calm();
    const i = REACTION_PROBES.findIndex((p) => p.kind === "deadline");
    runs[i] = runOf(REACTION_PROBES[i]!.id, "emphasize", "noted");
    expect(checkReactionSet(runs)).toContain(`${REACTION_PROBES[i]!.id}:not-allowed`);
  });
});
