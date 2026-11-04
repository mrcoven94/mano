// Parses a free-text answer to a yes-or-no approval question. Anything
// unclear returns null and the approval fails closed: the model asks
// again rather than guessing.
//
// A false yes files something, so the words of other languages count only
// as the whole message and only in their exact spelling. Vietnamese "có"
// needs its mark: "co", "cô" and "cỏ" are other words. Spanish "si" is
// also "if", so "si no" or "si puedo" asks again. Words that often mean
// only "I hear you" (Vietnamese "dạ", Tagalog "oo") or "already" (Spanish
// "ya") ask again too. Each word names its language, so Mano answers in it.
import type { ReplyLanguage } from "@mano/mail";

const YES = [/^\s*y(es|ep|up)?\s*[.!]?\s*$/i, /^\s*ok(ay)?\s*[.!]?\s*$/i, /^\s*sure\s*[.!]?\s*$/i, /^\s*do it\s*[.!]?\s*$/i, /^\s*go ahead\s*[.!]?\s*$/i, /^\s*approve(d)?\s*[.!]?\s*$/i, /^\s*confirmed?\s*[.!]?\s*$/i, /^\s*1\s*$/];
const NO = [/^\s*no?(pe)?\s*[.!]?\s*$/i, /^\s*don'?t\s*[.!]?\s*$/i, /^\s*stop\s*[.!]?\s*$/i, /^\s*cancel(led)?\s*[.!]?\s*$/i, /^\s*never mind\s*[.!]?\s*$/i, /^\s*not yet\s*[.!]?\s*$/i, /^\s*2\s*$/];

export type Decision = "yes" | "no";

const WORDS = new Map<string, { decision: Decision; language: ReplyLanguage | null }>([
  ["si", { decision: "yes", language: "es" }],
  ["sí", { decision: "yes", language: "es" }],
  ["có", { decision: "yes", language: "vi" }],
  ["opo", { decision: "yes", language: "tl" }],
  ["oui", { decision: "yes", language: null }],
  ["không", { decision: "no", language: "vi" }],
  ["hindi", { decision: "no", language: "tl" }],
  ["hindi po", { decision: "no", language: "tl" }],
  ["non", { decision: "no", language: null }],
]);

// NFC first: a phone can send "có" as a letter plus a combining mark. One
// closing mark at most, so "si..." stays the unfinished "if..." it is.
function wordOf(text: string) {
  const bare = text.normalize("NFC").trim().toLowerCase().replace(/^¡/, "").replace(/[.!]$/, "").replace(/\s+/g, " ");
  return WORDS.get(bare);
}

export function parseDecision(text: string): Decision | null {
  const clean = text.trim();
  if (YES.some((pattern) => pattern.test(clean))) return "yes";
  if (NO.some((pattern) => pattern.test(clean))) return "no";
  return wordOf(clean)?.decision ?? null;
}

// The language a decision word belongs to, when only one does.
export function decisionLanguage(text: string): ReplyLanguage | null {
  return wordOf(text)?.language ?? null;
}
