// Tapbacks: the model may start its reply with one line, "REACT: love"
// or "REACT: 🙏", to react to the person's message, with or without text
// after it. The rules around it are deterministic: no reaction in a
// crisis, on a reaction or on bad news. The
// worker alone sends EYES, while a slow turn is under way.

// The four tapbacks every iMessage client shows natively.
export type NativeTapback = "love" | "like" | "laugh" | "emphasize";
// Emoji reactions, for clients that show any emoji as a tapback.
export type EmojiTapback = "🙏" | "💪" | "🎉";
export type Tapback = NativeTapback | EmojiTapback;
// "Mano is on it": put on a message when the turn will take more than a
// moment, and swapped for the reply's own reaction when it has one.
export const EYES = "👀";
export type Reaction = Tapback | typeof EYES;

const NAMES: Record<string, Tapback> = {
  love: "love",
  like: "like",
  laugh: "laugh",
  emphasize: "emphasize",
  "❤": "love",
  "👍": "like",
  "😂": "laugh",
  "‼": "emphasize",
  "🙏": "🙏",
  "💪": "💪",
  "🎉": "🎉",
};

const REACT_LINE = /^\s*REACT:[ \t]*(\S*)[ \t]*(?:\n|$)/i;
// Variation selectors and skin tones do not change which reaction it is.
const EMOJI_MODIFIERS = /[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

export function splitTapback(text: string): { tapback: Tapback | null; text: string } {
  const match = REACT_LINE.exec(text);
  if (!match) return { tapback: null, text };
  const value = match[1].replace(EMOJI_MODIFIERS, "").toLowerCase();
  const tapback = Object.hasOwn(NAMES, value) ? NAMES[value]! : null;
  return { tapback, text: text.slice(match[0].length).trim() };
}

// Losing food, housing, coverage or income, or a denial.
const BAD_NEWS =
  /\b(?:cut|cuts|denied|deny|denial|lost|losing|lose|evict\w*|terminat\w*|ended|ending|stopped|cancel\w*|overpay\w*|owe|behind|late|reject\w*|closed|shut ?off|disconnect\w*|died|passed away|sick|hospital)\b/i;

// A reaction that reached Mano as text (SMS shows a tapback as
// 'Loved "..."'). Mano never reacts to a reaction.
const REACTION_TEXT =
  /^\s*(?:loved|liked|disliked|laughed at|emphasi[sz]ed|questioned|reacted \S{1,12} to|removed an? \S+ from|le (?:encantó|gustó|hizo gracia|dio risa|dio énfasis a)|no le gustó)\s+["“«]/iu;

export function isReactionText(personText: string): boolean {
  return REACTION_TEXT.test(personText);
}

// The one gate for every reaction Mano puts on a message, the eyes
// included: none in a crisis, none on a reaction, and none on bad news,
// where the only fitting response is words.
export function reactionEligible(personText: string, crisis: boolean): boolean {
  return !crisis && !isReactionText(personText) && !BAD_NEWS.test(personText);
}

export function allowedTapback(tapback: Tapback | null, personText: string, crisis: boolean): Tapback | null {
  if (!tapback || !reactionEligible(personText, crisis)) return null;
  return tapback;
}

// The person asked something, so a reaction alone is not an answer.
const QUESTION =
  /[?¿]|^\s*(?:what|when|where|which|who|whom|whose|why|how|can|could|would|will|should|do|does|did|is|are|am|was|were|qu[ée]|cu[áa]ndo|c[óo]mo|d[óo]nde|cu[áa]l(?:es)?|qui[ée]n(?:es)?|por qu[ée]|puedo|puedes|necesito)\b/imu;

export function needsAnswer(personText: string): boolean {
  return !isReactionText(personText) && QUESTION.test(personText);
}

// A tapback is decoration: when it cannot carry the reply (it fails, or
// there is no message to put it on), this text goes instead.
const TAPBACK_TEXT: Record<Tapback, string> = {
  love: "anytime!",
  like: "sounds good",
  laugh: "ha, yeah",
  emphasize: "noted",
  "🙏": "anytime!",
  "💪": "nice work!",
  "🎉": "that's great news!",
};

export function tapbackText(tapback: Tapback): string {
  return TAPBACK_TEXT[tapback];
}

// Sent when the model replied with only a tapback the rules refused
// (a heart on bad news), so the person still gets an answer.
export const REFUSED_TAPBACK_TEXT = "that's rough. tell me what happened?";

// Sent when the person asked something and the reply came back as a
// reaction alone, even after the responder asked again for words.
export const NEEDS_ANSWER_TEXT = "I don't have a good answer to that yet. Can you tell me a little more about what you need?";
