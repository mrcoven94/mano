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
// whole-message allowlist. A message qualifies only as a short pure form:
// at most MAX_PURE_WORDS words, made only of allowlisted phrases plus
// filler ("thanks!!", "thank you so much", "ok sounds good", "done,
// mailed it", "lol"). Anything with other content gets no reaction, so
// bad news riding along with a thanks never qualifies. The model may pick
// within the allowed set, or none. A reaction only ever goes on top of words.
export type MessageKind = "thanks" | "done" | "joke" | "ack";

export const MAX_PURE_WORDS = 6;

const PHRASES: ReadonlyArray<{ kind: MessageKind; phrases: readonly string[] }> = [
  {
    kind: "thanks",
    phrases: [
      "thank you", "thank u", "thanks", "thx", "ty", "tysm", "i appreciate it", "appreciate it", "appreciate you",
      // Purely positive, counted as thanks.
      "that helped", "helped a lot", "you're the best", "you rock", "life saver", "lifesaver", "amazing",
      "gracias por todo", "eres lo máximo", "muchas gracias", "mil gracias", "gracias",
    ],
  },
  { kind: "done", phrases: ["all done", "done", "i did it", "did it", "mailed it", "mailed", "sent it", "submitted it", "submitted", "i got approved", "got approved", "approved", "got it", "ya lo hice", "lo hice"] },
  { kind: "joke", phrases: ["lol", "lmao", "😂"] },
  { kind: "ack", phrases: ["sounds good", "got it", "okay", "ok", "kk", "k", "cool", "perfect", "vale"] },
];
// Words that may sit around a pure form without changing it.
const FILLER = new Set(["so", "much", "a", "lot", "guys", "mano", "you", "again"]);
const LAUGH = /^(?:(?:ha){2,}h?|(?:ja){2,}j?)$/;

const ALLOWS: Record<MessageKind, readonly Tapback[]> = {
  thanks: ["love", "🙏"],
  done: ["💪", "🎉"],
  joke: ["laugh"],
  ack: ["like"],
};

// The message as words: lowercased, 😂 kept as a word, other emoji and
// punctuation dropped.
function wordsOf(text: string): string[] {
  return normalizeQuotes(text)
    .toLowerCase()
    .replace(/😂/gu, " 😂 ")
    .replace(/[^\p{L}\p{N}'😂\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// The kinds a short pure form is made of, or none when anything else is
// in the message.
function pureKinds(text: string): MessageKind[] {
  const words = wordsOf(text);
  if (words.length === 0 || words.length > MAX_PURE_WORDS) return [];
  const kinds = new Set<MessageKind>();
  let i = 0;
  outer: while (i < words.length) {
    const w = words[i]!;
    if (LAUGH.test(w)) {
      kinds.add("joke");
      i += 1;
      continue;
    }
    // Longest phrase first; a phrase in two lists ("got it") counts for both.
    let matched = 0;
    for (const { kind, phrases } of PHRASES) {
      for (const phrase of phrases) {
        const parts = phrase.split(" ");
        if (parts.length >= matched && parts.every((p, k) => words[i + k] === p)) {
          if (parts.length > matched) {
            matched = parts.length;
          }
          kinds.add(kind);
          break;
        }
      }
    }
    if (matched > 0) {
      i += matched;
      continue outer;
    }
    if (FILLER.has(w)) {
      i += 1;
      continue;
    }
    return [];
  }
  return [...kinds];
}

// A second layer under the allowlist: bad news, a hardship or a negation
// anywhere in the message means no reaction.
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
  // The bad-news veto stays as a second layer.
  if (isReactionText(text) || vetoed(text)) return [];
  return pureKinds(text);
}

// The reactions the target message allows, empty for most messages.
export function allowedReactions(targetText: string, crisis: boolean): Tapback[] {
  if (crisis) return [];
  const kinds = reactionKinds(targetText);
  return [...new Set((["thanks", "done", "joke", "ack"] as const).filter((k) => kinds.includes(k)).flatMap((k) => ALLOWS[k]))];
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
