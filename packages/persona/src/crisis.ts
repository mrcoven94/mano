// Crisis floor. The soul tells the model what to do in a crisis; this
// is the deterministic net underneath it. Detection is never the only
// protection: every busy, over-limit and failure reply carries
// SAFETY_LINE, and on those paths the broad mightBeCrisis sends
// CRISIS_LINE. isCrisis routes a message away from the deep path and
// makes its normal reply name 988 and 911.

export const CRISIS_LINE =
  "I'm really glad you told me. Please call or text 988 right now, they're there 24/7 and it's free. " +
  "If you're in danger right now, call 911. I'm here too.";

// One sentence, added to every reply Mano sends without the model.
export const SAFETY_LINE = "If you're in danger or thinking about hurting yourself, call 911 or text 988.";

// An overdose needs a harm signal (swallowed, took all, downed, too
// many, a whole bottle) plus a substance, so "a bottle of water" or
// "my meds every morning" does not count.
// Self-harm, violence and explicit danger count anywhere, next to
// housing or money words too.
// Benefits, money and work words. "cut my food stamps" and "in danger of
// losing my benefits" are benefits questions, not a crisis.
const BENEFIT_NOUNS =
  "food stamps|snap|ebt|benefits?|hours|shifts?|pay|paycheck|check|wages|salary|coverage|insurance|medicaid|rent|budget|bills?|phone|power|lights|water|gas|hair";
const BENEFIT_WORDS = `${BENEFIT_NOUNS}|evicted|cut off|dropped|shut off|kicked out`;

const SELF_HARM =
  /\b(?:suicid(?:e|al)|kill(?:ing)? myself|hang(?:ing)? myself|end (?:my life|it all)|(?:want|wanna) to die|wanna die|better off dead|(?:hurt|hurting|harm|harming|cut|cutting) myself|self harm|overdos\w*|(?:swallowed|took all|take all|downed|took (?:a|the) (?:whole|entire)|took too many|took a (?:handful|bunch))\b[^.!?]{0,30}\b(?:pills|meds|medications?|medicines?|tablets|painkillers)|(?:swallowed|took all|downed) (?:a |the )?(?:whole|entire) bottle|(?:don'?t|do not) want to (?:be here|live))\b/;
const VIOLENCE =
  /\b(?:(?:hit|hits|hitting|beat|beats|beating|hurt|hurts|hurting|choked?|choking|kick(?:s|ed|ing)?|attack(?:s|ed|ing)?|abus(?:es|ed|ing)) (?:me|us|my (?:kids?|children|son|daughter|baby))|(?:being|been|was|got) (?:abused|hit|beaten|attacked|choked)|abusive|domestic (?:abuse|violence)|(?:threaten(?:s|ed)?|going|gonna|wants?|tried|trying) to kill (?:me|us|myself|him|her|them)|kill me)\b/;
const DANGER = /\b(?:immediate danger|in danger|not safe|unsafe|(?:don'?t|do not) feel safe)\b/;
// Exclusions neutralize only their own trigger words, and only when a
// benefits, money or work word follows within 3 words: "in danger of
// losing" or "in danger of being" ("in danger of losing my SNAP", "in
// danger of being evicted"), and a single "cut", "cuts" or "cutting"
// ("they cut my food stamps", "cutting back my shifts"). They never
// delete a neighboring word, so any other crisis word in the message
// ("in danger of being killed over rent", "they cut my SNAP and I want to
// die") is still read.
const NEUTRALIZERS = [
  /\bin danger of being cut off\b/g,
  new RegExp(`\\bin danger of (?:losing|being)(?=(?: [a-z']+){0,2}? (?:${BENEFIT_WORDS})\\b)`, "g"),
  new RegExp(`\\bcut(?:s|ting)?(?=(?: [a-z']+){0,2} (?:${BENEFIT_NOUNS})\\b)`, "g"),
];

function neutralize(words: string): string {
  return NEUTRALIZERS.reduce((out, pattern) => out.replace(pattern, " "), words);
}

// "cut", "cuts" and "cutting" count: safe by default, since no list of
// body parts or phrasings is ever complete. Over-triggering is accepted.
// Broad on purpose, with no other exclusions: used only where no model runs
// (over a limit, out of budget, a failed call), so a match costs one
// fixed text and silence is never the answer.
const POSSIBLE_CRISIS = new RegExp(String.raw`\b(?:danger\w*|safe|unsafe|hurt\w*|hit|hits|hitting|beat\w*|abus\w*|kill\w*|die|dying|dead|suicid\w*|scared|afraid|terrified|threat\w*|really bad|emergency|weapon|gun|knife|bleeding|attack\w*|chok\w*|overdos\w*|pills?|hang|hanging|noose|cut(?:s|ting)?|slit\w*|wrists?|throw(?:ing)? myself|jump(?:ing)? off|kill myself|end it|end my life|(?:not|don'?t|do not) want to (?:live|be here)|better off dead)\b`);

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `;
}

export function isCrisis(text: string): boolean {
  const words = neutralize(normalize(text));
  return SELF_HARM.test(words) || VIOLENCE.test(words) || DANGER.test(words);
}

export function mightBeCrisis(text: string): boolean {
  return isCrisis(text) || POSSIBLE_CRISIS.test(neutralize(normalize(text)));
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
export function holdCrisisLines(bubbles: readonly string[]): string[] {
  return [CRISIS_LINE, ...bubbles.filter((b) => b !== CRISIS_LINE)];
}
