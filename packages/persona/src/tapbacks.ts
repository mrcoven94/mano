// Tapbacks: the model may start its reply with one line, "REACT: love"
// or "REACT: 🙏", to react to the person's message, with or without text
// after it. Code decides which reactions the message allows (see
// allowedReactions); the model only picks within that set. The worker
// alone sends EYES, once, on a slow turn, and never takes it off.

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

// Words as whole words, in any language: JavaScript's \b is ASCII only.
function words(list: readonly string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

// Curly quotes and apostrophes become straight ones before any check, so
// "can’t" and "can't" read the same.
export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″«»]/g, '"');
}

// A reaction that reached Mano as text (SMS shows a tapback as
// 'Loved "..."'). Mano never reacts to a reaction.
const REACTION_TEXT =
  /^\s*(?:loved|liked|disliked|laughed at|emphasi[sz]ed|questioned|reacted \S{1,12} to|removed an? \S+ from|le (?:encantó|gustó|hizo gracia|dio risa|dio énfasis a)|no le gustó|enfatizó|cuestionó|se rió de)\s+"/iu;

export function isReactionText(personText: string): boolean {
  return REACTION_TEXT.test(normalizeQuotes(personText));
}

// Reactions are decided by code from the target message's own text: a
// positive allowlist. A message that is none of these gets no reaction,
// so bad news never qualifies. The model may pick within the set, or none.
// A reaction only ever goes on top of words.
export type MessageKind = "thanks" | "done" | "joke" | "ack";

const KINDS: ReadonlyArray<{ kind: MessageKind; pattern: RegExp; allows: readonly Tapback[] }> = [
  { kind: "thanks", pattern: words(["thank\\w*", "ty", "appreciate\\w*", "gracias"]), allows: ["love", "🙏"] },
  { kind: "done", pattern: words(["done", "did it", "mailed", "sent it", "submitted", "approved", "got it", "lo hice"]), allows: ["💪", "🎉"] },
  { kind: "joke", pattern: /(?<![\p{L}\p{N}])(?:ha(?:ha)+|lol|lmao|ja(?:ja)+)(?![\p{L}\p{N}])|😂/iu, allows: ["laugh"] },
  { kind: "ack", pattern: words(["ok", "okay", "k", "cool", "sounds good", "got it", "perfect", "vale"]), allows: ["like"] },
];

// A veto on top of the allowlist: a thanks or a "got it" that also
// carries bad news, a hardship or a negation gets no reaction.
const VETO = words([
  // Losing or not getting help, in English.
  "reduc\\w*", "cut", "cuts", "cutting", "lost", "losing", "lose", "denied", "deny", "denial", "reject\\w*", "terminat\\w*",
  "ended", "ending", "stopped", "stopping", "overdue", "behind", "late", "owe", "overpay\\w*", "evict\\w*", "fired", "laid off",
  "cancel\\w*", "closed", "shut ?off", "disconnect\\w*", "died", "passed away", "sick", "hospital",
  // Hardship and negation.
  "can't", "cannot", "can not", "don't have", "haven't", "no food", "no money", "not", "never", "\\w+n't",
  // The same in Spanish.
  "reduj\\w*", "reduc\\w*", "recort\\w*", "cort\\w*", "perd[ií]\\w*", "neg\\w*", "rechaz\\w*", "termin\\w*", "venci\\w*",
  "atrasad\\w*", "debo", "desalojo", "desalojar\\w*", "despid\\w*", "no puedo", "no tengo", "sin comida", "sin dinero",
  "nunca", "todav[ií]a no", "no (?:lo|la|me|se|he|ha|han)",
]);

function vetoed(text: string): boolean {
  return VETO.test(text);
}

export function reactionKinds(targetText: string): MessageKind[] {
  const text = normalizeQuotes(targetText);
  if (isReactionText(text) || vetoed(text)) return [];
  return KINDS.filter((k) => k.pattern.test(text)).map((k) => k.kind);
}

// The reactions the target message allows, empty for most messages.
export function allowedReactions(targetText: string, crisis: boolean): Tapback[] {
  if (crisis) return [];
  const kinds = new Set(reactionKinds(targetText));
  return [...new Set(KINDS.filter((k) => kinds.has(k.kind)).flatMap((k) => k.allows))];
}

// The model's pick, kept only when the target message allows it.
export function allowedTapback(tapback: Tapback | null, targetText: string, crisis: boolean): Tapback | null {
  return tapback && allowedReactions(targetText, crisis).includes(tapback) ? tapback : null;
}

// Whether the eyes may go on a slow turn's message: never in a crisis, on
// a reaction or on bad news.
export function eyesAllowed(targetText: string, crisis: boolean): boolean {
  const text = normalizeQuotes(targetText);
  return !crisis && !isReactionText(text) && !vetoed(text);
}
