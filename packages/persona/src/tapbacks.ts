// Tapbacks: the model may start its reply with one line, "REACT: love",
// to put a tapback on the person's message, with or without text after
// it. The rules around it are deterministic: no tapback in a crisis, and
// no heart or laugh on bad news.

export type Tapback = "love" | "like" | "laugh" | "emphasize";

const TAPBACKS: readonly Tapback[] = ["love", "like", "laugh", "emphasize"];
const REACT_LINE = /^\s*REACT:[ \t]*([a-z]*)[ \t]*(?:\n|$)/i;

export function splitTapback(text: string): { tapback: Tapback | null; text: string } {
  const match = REACT_LINE.exec(text);
  if (!match) return { tapback: null, text };
  const value = match[1].toLowerCase();
  const tapback = (TAPBACKS as readonly string[]).includes(value) ? (value as Tapback) : null;
  return { tapback, text: text.slice(match[0].length).trim() };
}

// Losing food, housing, coverage or income, or a denial: no heart, no laugh.
const BAD_NEWS =
  /\b(?:cut|cuts|denied|deny|denial|lost|losing|lose|evict\w*|terminat\w*|ended|ending|stopped|cancel\w*|overpay\w*|owe|behind|late|reject\w*|closed|shut ?off|disconnect\w*|died|passed away|sick|hospital)\b/i;

export function allowedTapback(tapback: Tapback | null, personText: string, crisis: boolean): Tapback | null {
  if (!tapback || crisis) return null;
  if ((tapback === "love" || tapback === "laugh") && BAD_NEWS.test(personText)) return null;
  return tapback;
}

// A tapback is decoration: when it cannot carry the reply (it fails, or
// there is no message to put it on), this text goes instead.
const TAPBACK_TEXT: Record<Tapback, string> = {
  love: "anytime!",
  like: "sounds good",
  laugh: "ha, yeah",
  emphasize: "noted",
};

export function tapbackText(tapback: Tapback): string {
  return TAPBACK_TEXT[tapback];
}

// Sent when the model replied with only a tapback the rules refused
// (a heart on bad news), so the person still gets an answer.
export const REFUSED_TAPBACK_TEXT = "that's rough. tell me what happened?";
