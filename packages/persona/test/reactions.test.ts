import { describe, expect, it } from "vitest";
import { guardReply } from "../src/guard.js";
import { MANO_SOUL } from "../src/soul.js";
import { EYES, allowedTapback, isReactionText, needsAnswer, splitTapback, tapbackText } from "../src/tapbacks.js";
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

  it("never puts a heart, laugh, flex or party on bad news", () => {
    for (const t of ["love", "laugh", "💪", "🎉"] as const) {
      expect(allowedTapback(t, "they denied my medicaid", false), t).toBeNull();
    }
    expect(allowedTapback("🙏", "they denied my medicaid", false)).toBe("🙏");
    expect(allowedTapback("💪", "just mailed the renewal packet", false)).toBe("💪");
  });

  it("never reacts on a crisis turn or on a reaction sent as text", () => {
    expect(allowedTapback("🙏", "thank you", true)).toBeNull();
    for (const text of ["Loved “your renewal is due Friday”", 'Liked "ok"', "Laughed at “fax machines”", "Reacted 👍 to “ok”", "Le encantó “gracias”"]) {
      expect(isReactionText(text), text).toBe(true);
      expect(allowedTapback("love", text, false), text).toBeNull();
    }
    expect(isReactionText("loved it, thanks")).toBe(false);
  });

  it("knows when the person asked something a reaction cannot answer", () => {
    for (const text of ["When is my SNAP renewal due?", "can you help me with the form", "¿Cuándo vence mi renovación?", "what do i need for WIC"]) {
      expect(needsAnswer(text), text).toBe(true);
    }
    for (const text of ["thank you!!", "ok will do", "submitted it!", "lol who has a fax"]) {
      expect(needsAnswer(text), text).toBe(false);
    }
  });

  it("has a short text fallback for every emoji", () => {
    for (const t of ["🙏", "💪", "🎉"] as const) expect(tapbackText(t).length).toBeGreaterThan(0);
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
    const bad = set("bad-news", "love");
    const crisis = set("crisis", "🙏", "please call or text 988");
    const reaction = set("reaction", "like");
    const question = set("question", "like", "");
    const failed = checkReactionSet(runs);
    expect(failed).toContain(`${bad}:bad-news-reaction`);
    expect(failed).toContain(`${crisis}:crisis-reaction`);
    expect(failed).toContain(`${reaction}:reaction-on-reaction`);
    expect(failed).toContain(`${question}:reaction-instead-of-answer`);
  });

  it("passes a varied, sparing set", () => {
    const runs = calm();
    const pick: Record<string, ReactionRun["tapback"]> = { thanks: "love", joke: "laugh", done: "💪", deadline: "emphasize", "good-news": "🎉" };
    for (const [kind, tapback] of Object.entries(pick)) {
      const i = REACTION_PROBES.findIndex((p) => p.kind === kind);
      runs[i] = runOf(REACTION_PROBES[i]!.id, tapback, "");
    }
    expect(checkReactionSet(runs)).toEqual([]);
  });
});
