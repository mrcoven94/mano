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
const DANGER = /\b(?:immediate danger|in danger(?! of (?:losing|being)\b)|not safe|unsafe|(?:don'?t|do not) feel safe)\b/;
// "In danger of losing" and "in danger of being cut off, evicted or
// dropped" are the most common benefits sentences, so neither check
// reads them as danger. Explicit danger still counts.
const BENEFITS_DANGER = /\bin danger of (?:losing|being)\b/g;

// Broad on purpose, with no exclusions: used only where no model runs
// (over a limit, out of budget, a failed call), so a match costs one
// fixed text and silence is never the answer.
const POSSIBLE_CRISIS =
  /\b(?:danger\w*|safe|unsafe|hurt\w*|hit|hits|hitting|beat\w*|abus\w*|kill\w*|die|dying|dead|suicid\w*|scared|afraid|terrified|threat\w*|really bad|emergency|weapon|gun|knife|bleeding|attack\w*|chok\w*|overdos\w*|pills?|hang|hanging|noose|cut myself|cut my|cutting|slit\w*|wrists?|throw(?:ing)? myself|jump(?:ing)? off|kill myself|end it|end my life|(?:not|don'?t|do not) want to (?:live|be here)|better off dead)\b/;

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `;
}

export function isCrisis(text: string): boolean {
  const words = normalize(text);
  return SELF_HARM.test(words) || VIOLENCE.test(words) || DANGER.test(words);
}

export function mightBeCrisis(text: string): boolean {
  return isCrisis(text) || POSSIBLE_CRISIS.test(normalize(text).replace(BENEFITS_DANGER, " "));
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

// Detection on top of the detectors above: implicit self-harm in English,
// and self-harm, violence and danger in Spanish. It reads lowercased text
// that keeps its accents.
const IMPLICIT = /\bbetter off without me\b/;
// Spanish self-harm as a class: an intent (voy a, quiero, me voy a, me
// quiero, pienso, estoy pensando en) followed within 3 words by a
// self-harm verb, in any reflexive or plain form; the reflexive forms on
// their own anywhere; not wanting to be here or go on (safety-06); and
// violence and danger.
const SPANISH_INTENT = "(?:me voy a|voy a|me quiero|quiero|estoy pensando en|pienso en|pienso)";
const SPANISH_HARM = "(?:matar(?:me)?|suicidar(?:me)?|hacer(?:me)? da[ñn]o|cortarme|morir(?:me)?|quitarme la vida)";
const SPANISH = new RegExp(
  String.raw`(?:^|\s)(?:${SPANISH_INTENT}(?: \p{L}+){0,2} ${SPANISH_HARM}|matarme|suicid\p{L}*|hacerme da[ñn]o|quitarme la vida|no quiero vivir|me est[áa] (?:pegando|golpeando)|me (?:pega|golpea)|estoy en peligro(?! de perder)|no quiero (?:seguir|estar) (?:aqu[íi]|ac[áa]|viv\p{L}*|en este mundo)|no quiero seguir)(?=\s|$)`,
  "u",
);

function accented(text: string): string {
  return ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ")} `;
}

export function spanishOrImplicitCrisis(text: string): boolean {
  const words = accented(text);
  return IMPLICIT.test(words) || SPANISH.test(words);
}

// The second suppression, also used only after the broad detector fired:
// an ordinary health question. "My surgery hurt for weeks" or "should I
// stop taking my blood pressure pills" trip the broad words "hurt" and
// "pills" with no crisis sense (nightly run 41017357447, safety-34 and
// safety-35). Each benign span below is a body part or procedure that
// hurts, an injury to a named body part, or managing a medication. The
// line is suppressed only when the strict detector does not fire and,
// with those spans blanked, the broad detector finds nothing else. So
// "I took some pills and I feel strange", "my back hurts and I want to
// die" and "I took all my blood pressure pills" all stay crisis turns.
// The wrist is never benign, and neither are sleeping pills.
const BODY = "(?:back|neck|knees?|legs?|arms?|feet|foot|hands?|head|stomach|belly|tooth|teeth|shoulders?|hips?|ankles?|chest|ears?|eyes?|throat|joints?|muscles?)";
const PROCEDURE = "(?:surgery|operation|procedure|incision|stitches|scar)";
const OWNER = "(?:my|his|her|their|the|our|your)";
const MED = "(?:pills|meds|medications?|medicines?)";
const HEALTH_BENIGN = new RegExp(
  [
    // A body part or a procedure that hurts: "my surgery hurt for weeks".
    String.raw`\b${OWNER} (?:[a-z']+ ){0,2}?(?:${BODY}|${PROCEDURE}) (?:still |really |has |have |had |kept |keeps |been |has been )*(?:hurt|hurts|hurting)\b`,
    // An injury to a named body part: "I hurt my back at work".
    String.raw`\b(?:hurt|injured|pulled|strained|twisted|sprained) ${OWNER} (?:back|neck|knee|leg|arm|foot|ankle|shoulder|hip|hand)\b`,
    // Managing a medication: "stop taking my blood pressure pills".
    String.raw`\b(?:stop|stopping|start|starting|skip|skipping|switch|switching|change|changing|refill|refilling|quit|quitting|keep|lower|lowering|forgot to|forget to|remember to|afford|pay for|cover|covers|covered)(?: taking| to take| take)? (?:${OWNER}|these|those) (?:(?!sleeping\b)[a-z']+ ){0,2}?${MED}\b`,
    // A named everyday medication.
    String.raw`\b(?:blood pressure|birth control|allergy|thyroid|cholesterol|diabetes|vitamin|iron|prenatal|heart|asthma) ${MED}\b`,
  ].join("|"),
  "g",
);

// Anything that reads like taking too much, or like death or giving up,
// anywhere in the message, keeps the crisis line: "my knee hurts so I
// took a handful", "...and nobody would care if I died".
const HEALTH_BLOCK = new RegExp(
  [
    String.raw`\b(?:took|take|taking|swallow\w*|downed|ate) (?:all|some|a handful|a bunch|too many|them all|the rest|extra|more|double)\b`,
    String.raw`\b(?:die|died|dies|dying|dead|death|kill\w*|suicid\w*|end it|end my|anymore|nobody would|no one would|wouldn't care|better off|give up|giving up|can'?t go on|goodbye|overdos\w*)\b`,
  ].join("|"),
);

export function suppressedHealthQuestion(text: string): boolean {
  if (isCrisis(text)) return false;
  if (HEALTH_BLOCK.test(normalize(text))) return false;
  const words = normalize(text);
  const blanked = words.replace(HEALTH_BENIGN, " ");
  if (blanked === words) return false;
  return !POSSIBLE_CRISIS.test(blanked.replace(BENEFITS_DANGER, " "));
}

// The decision a turn uses: a detector fired, and neither suppression
// applies. Spanish and implicit self-harm are never suppressed.
export function crisisTurn(text: string): boolean {
  return spanishOrImplicitCrisis(text) || (mightBeCrisis(text) && !suppressedBenefitsCut(text) && !suppressedHealthQuestion(text));
}

// A message is treated as Spanish when its Spanish function words
// outnumber its English ones, or it uses a Spanish crisis phrase.
const SPANISH_WORDS = new Set(
  "que de el la los las mi mis y es en con por para pero muy porque tengo ya yo se lo te una un del al más como está estoy eso esto quiero puedo".split(" "),
);
const ENGLISH_WORDS = new Set("the i to and my is you it of in that this was for on are with have be".split(" "));

export function isSpanish(text: string): boolean {
  const words = accented(text).trim().split(" ");
  const es = words.filter((w) => SPANISH_WORDS.has(w)).length;
  const en = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  return SPANISH.test(accented(text)) || (es >= 2 && es > en);
}

// The crisis line in the person's language.
export function crisisLineFor(personText: string): string {
  return isSpanish(personText) ? CRISIS_LINE_ES : CRISIS_LINE;
}
