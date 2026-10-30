// Crisis floor. The soul tells the model what to do in a crisis; this
// is the deterministic net underneath it. Detection is never the only
// protection: every busy, over-limit and failure reply carries
// SAFETY_LINE, and on those paths the broad mightBeCrisis sends
// CRISIS_LINE. isCrisis routes a message away from the deep path and
// makes its normal reply name 988 and 911.

export const CRISIS_LINE =
  "I'm really glad you told me. Please call or text 988 right now, they're there 24/7 and it's free. " +
  "If you're in danger right now, call 911. I'm here too.";

// The crisis line for a message written in Spanish, with both numbers.
export const CRISIS_LINE_ES = "Si estás en peligro o piensas en hacerte daño, llama al 911 o envía un mensaje al 988.";

// One sentence, added to every reply Mano sends without the model.
export const SAFETY_LINE = "If you're in danger or thinking about hurting yourself, call 911 or text 988.";

// An overdose needs a harm signal (swallowed, took all, downed, too
// many, a whole bottle) plus a substance, so "a bottle of water" or
// "my meds every morning" does not count.
// Self-harm, violence and explicit danger count anywhere, next to
// housing or money words too. The one exception is "in danger of
// losing", which is a benefits question.
const SELF_HARM =
  /\b(?:suicid(?:e|al)|kill(?:ing)? myself|hang(?:ing)? myself|end (?:my life|it all)|(?:want|wanna) to die|wanna die|better off dead|(?:hurt|hurting|harm|harming|cut|cutting) myself|self harm|overdos\w*|(?:swallowed|took all|take all|downed|took (?:a|the) (?:whole|entire)|took too many|took a (?:handful|bunch))\b[^.!?]{0,30}\b(?:pills|meds|medications?|medicines?|tablets|painkillers)|(?:swallowed|took all|downed) (?:a |the )?(?:whole|entire) bottle|(?:don'?t|do not) want to (?:be here|live))\b/;
const VIOLENCE =
  /\b(?:(?:hit|hits|hitting|beat|beats|beating|hurt|hurts|hurting|choked?|choking|kick(?:s|ed|ing)?|attack(?:s|ed|ing)?|abus(?:es|ed|ing)) (?:me|us|my (?:kids?|children|son|daughter|baby))|(?:being|been|was|got) (?:abused|hit|beaten|attacked|choked)|abusive|domestic (?:abuse|violence)|(?:threaten(?:s|ed)?|going|gonna|wants?|tried|trying) to kill (?:me|us|myself|him|her|them)|kill me)\b/;
const DANGER = /\b(?:immediate danger|in danger|not safe|unsafe|(?:don'?t|do not) feel safe)\b/;
// Implicit self-harm in English, and self-harm, violence and danger in
// Spanish. Patterns run on lowercased text that keeps accents.
const IMPLICIT = /\bbetter off without me\b/;
const SPANISH =
  /(?:^|\s)(?:quiero morir(?:me)?|me quiero (?:morir|matar)|quiero matarme|me voy a matar|suicid\p{L}*|hacerme da[ñn]o|no quiero vivir|me est[áa] (?:pegando|golpeando)|me (?:pega|golpea)|estoy en peligro(?! de perder))(?=\s|$)/u;
// Exclusions. One is eligible only when all of these hold:
// (a) it sits inside one sentence; sentence boundaries are never lost;
// (b) for a cut, the speaker is not the cutter: no first-person singular
//     in that sentence ("they cut my food stamps" is eligible, "I cut my
//     arm" and "I need to cut my bills" are not);
// (c) the benefits, money or work noun is the direct object right after
//     the verb, with only my, our, the, back or off in between, so "cut
//     my leg hours ago" is never a work cut;
// (d) no other crisis word is left in the whole message once the trigger
//     words are removed (the second pass).
// "In danger of losing" or "in danger of being" before a benefits word
// ("in danger of losing my SNAP", "in danger of being evicted") is
// eligible under (a), (c) and (d). Only the trigger words are removed.
const BETWEEN = "(?:(?:my|our|the|back|off) )*";
const CUT_CANDIDATE = new RegExp(String.raw`\bcut(?:s|ting)?(?= ${BETWEEN}(?:${BENEFIT_NOUNS})\b)`, "g");
const BEING_CUT_OFF = /(?<=\bbeing )cut(?= off\b)/g;
const DANGER_CANDIDATE = new RegExp(String.raw`\bin danger of (?:losing|being)(?= ${BETWEEN}(?:${BENEFIT_WORDS})\b)`, "g");
const FIRST_PERSON = /\b(?:i|i'm|im|i've|ive|i'd|me|myself|my self)\b/;

// The candidates of one sentence are all found on the unchanged words,
// then blanked at once, so removing one never changes another.
function withoutCandidates(sentence: string): string {
  const patterns = FIRST_PERSON.test(sentence) ? [BEING_CUT_OFF, DANGER_CANDIDATE] : [CUT_CANDIDATE, BEING_CUT_OFF, DANGER_CANDIDATE];
  const blank = new Array<boolean>(sentence.length).fill(false);
  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      for (let k = match.index; k < match.index + match[0].length; k++) blank[k] = true;
    }
  }
  return [...sentence].map((ch, k) => (blank[k] ? " " : ch)).join("");
}

// "cut", "cuts" and "cutting" count: safe by default, since no list of
// body parts or phrasings is ever complete. Over-triggering is accepted.
// Broad on purpose, with no other exclusions: used only where no model runs
// (over a limit, out of budget, a failed call), so a match costs one
// fixed text and silence is never the answer.
const POSSIBLE_CRISIS =
  /\b(?:danger\w*|safe|unsafe|hurt\w*|hit|hits|hitting|beat\w*|abus\w*|kill\w*|die|dying|dead|suicid\w*|scared|afraid|terrified|threat\w*|really bad|emergency|weapon|gun|knife|bleeding|attack\w*|chok\w*|overdos\w*|pills?|hang|hanging|noose|cut(?:ting)? myself|cut(?:ting)? my (?!(?:food stamps|snap|ebt|benefits?|hours|shifts?|pay|paycheck|check|wages|salary|coverage|insurance|medicaid|rent|budget|bills?|phone|power|lights|water|gas|hair)\b)[a-z]+|slit\w*|wrists?|throw(?:ing)? myself|jump(?:ing)? off|kill myself|end it|end my life|(?:not|don'?t|do not) want to (?:live|be here)|better off dead)\b/;

// Lowercase, straight apostrophes, letters (accents kept) and digits only.
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ")} `;
}

// Each sentence on its own, so no pattern or exclusion reaches across a
// boundary ("I cut my arm. Rent is due.").
function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?…;\n]+/)
    .map(normalize)
    .filter((s) => s.trim().length > 0);
}

function narrow(words: string): boolean {
  return SELF_HARM.test(words) || VIOLENCE.test(words) || DANGER.test(words) || IMPLICIT.test(words) || SPANISH.test(words);
}

function broad(words: string): boolean {
  return narrow(words) || POSSIBLE_CRISIS.test(words);
}

// Two passes. The detectors run on every sentence unchanged; if one
// fires, the eligible exclusions' trigger words are removed and both run
// again on the whole message. The crisis line is suppressed only when
// neither fires on that second pass.
export function isCrisis(text: string): boolean {
  const sentences = sentencesOf(text);
  return sentences.some(narrow) && sentences.map(withoutCandidates).some(broad);
}

export function mightBeCrisis(text: string): boolean {
  const sentences = sentencesOf(text);
  return sentences.some(broad) && sentences.map(withoutCandidates).some(broad);
}

// A message is treated as Spanish when its Spanish function words
// outnumber its English ones, or it uses a Spanish crisis phrase.
const SPANISH_WORDS = new Set(
  "que de el la los las mi mis y es en con por para pero muy porque tengo ya yo se lo te una un del al más como está estoy eso esto quiero puedo".split(" "),
);
const ENGLISH_WORDS = new Set("the i to and my is you it of in that this was for on are with have be".split(" "));

export function isSpanish(text: string): boolean {
  const words = normalize(text).trim().split(" ");
  const es = words.filter((w) => SPANISH_WORDS.has(w)).length;
  const en = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  return SPANISH.test(normalize(text)) || (es >= 2 && es > en);
}

// The crisis line in the person's language.
export function crisisLineFor(personText: string): string {
  return isSpanish(personText) ? CRISIS_LINE_ES : CRISIS_LINE;
}

export function namesCrisisLines(reply: string): boolean {
  return /\b988\b/.test(reply) && /\b911\b/.test(reply);
}

// The reply a crisis turn sends: the model's own words when they name
// both lines, otherwise CRISIS_LINE first.
export function crisisFloor(reply: string): string {
  return namesCrisisLines(reply) ? reply : `${CRISIS_LINE} ${reply}`.trim();
}

// The last step on a crisis turn's outgoing bubbles, after the guard,
// the link check and splitting: the fixed CRISIS_LINE, naming 988 and
// 911, is always the first bubble and appears once. Callers cap the
// bubbles after it, so the cap can never drop it.
export function holdCrisisLines(bubbles: readonly string[], line: string = CRISIS_LINE): string[] {
  return [line, ...bubbles.filter((b) => b !== CRISIS_LINE && b !== CRISIS_LINE_ES)];
}

// Suppression, the only exception to the detectors above, and used only
// after one fired. A sentence that is exactly someone else cutting a
// benefit ("they cut my food stamps", "my boss is cutting my shifts") is
// a benefits question. The crisis line is suppressed only when every
// sentence that triggers is exactly that: no other sentence triggers on
// its own, and the other sentences rejoined trigger nothing either. The detectors stay
// exactly as they are; nothing here can make them miss a crisis word.
const BENEFITS_CUT_SENTENCE = new RegExp(
  "^(?:they|he|she|my boss|my job|work|the county|the state|the office|snap|medicaid|the landlord|the company|my employer)" +
    "(?: is| are|'s|'re)? (?:cut|cuts|cutting|cut back|cutting back)(?: back| off)? (?:my|our|the) " +
    "(?:food stamps|snap|ebt|benefits|hours|shifts|pay|paycheck|wages|medicaid|coverage|insurance|power|lights|water|gas|phone)" +
    "(?: off)?[\\s.!?,;:]*$",
  "i",
);

// Newlines are spaces here, so a line break never makes a template
// sentence out of part of a longer one ("they cut my benefits\nand my
// throat"). Sentences end only at . ! or ? before whitespace or the end.
function sentencesOf(text: string): string[] {
  return text
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function suppressedBenefitsCut(text: string): boolean {
  const sentences = sentencesOf(text);
  const template = sentences.filter((s) => BENEFITS_CUT_SENTENCE.test(s));
  if (template.length === 0) return false;
  if (!template.some((s) => mightBeCrisis(s))) return false;
  // Rejoined with ". " so phrases on either side of a removed sentence
  // can never fuse into a new one.
  const others = sentences.filter((s) => !BENEFITS_CUT_SENTENCE.test(s));
  // Both must hold: no other sentence triggers on its own, and the other
  // sentences rejoined trigger nothing either.
  if (others.some((s) => mightBeCrisis(s))) return false;
  return !mightBeCrisis(others.join(". "));
}

// The decision a turn uses: a detector fired, and suppression does not apply.
export function crisisTurn(text: string): boolean {
  return mightBeCrisis(text) && !suppressedBenefitsCut(text);
}
