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
const POSSIBLE_CRISIS = new RegExp(String.raw`\b(?:danger\w*|safe|unsafe|hurt\w*|hit|hits|hitting|beat\w*|abus\w*|kill\w*|die|dying|dead|suicid\w*|scared|afraid|terrified|threat\w*|really bad|emergency|weapon|gun|knife|bleeding|attack\w*|chok\w*|overdos\w*|pills?|hang|hanging|noose|cut(?:s|ting)?|slit\w*|wrists?|throw(?:ing)? myself|jump(?:ing)? off|kill myself|end it|end my life|(?:not|don'?t|do not) want to (?:live|be here)|better off dead)\b`);

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `;
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
  return SELF_HARM.test(words) || VIOLENCE.test(words) || DANGER.test(words);
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
