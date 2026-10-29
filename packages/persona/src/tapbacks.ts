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
