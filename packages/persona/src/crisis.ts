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

// Wanting everything to end, "what's the point anymore", and taking a
// whole bottle or all of a medicine: crises on their own (Lead's check of
// PR 77). "What's the point of renewing" and "the program ended" are not.
const ENDING = new RegExp(
  [
    String.raw`\b(?:want|wants|wanted|wish|need)(?: for)? (?:everything|it all|it|this|all of this|all this|the pain|my life|life)(?: all)? to (?:end|be over|stop forever|stop for good)\b`,
    String.raw`\b(?:wish|want) (?:it|everything|this|it all) (?:would|could) (?:all )?(?:end|be over|stop forever)\b`,
    String.raw`\b(?:make|let) (?:it|everything|this|it all)(?: all)? (?:end|be over)\b`,
    String.raw`\bwhat'?s the point\b(?! (?:of|in|to) (?!living\b|life\b|anything\b|it all\b|going on\b|trying\b|being here\b|any of this\b))`,
    String.raw`\bno point (?:anymore|in (?:living|anything|going on|trying|being here)|to (?:living|anything|life))\b`,
    String.raw`\b(?:took|take|taking|swallowed|downed|drank|injected|used|ate) (?:my |the |a |an |all of my |all of the )?(?:whole|entire) (?:bottle|box|pack|vial|supply|prescription)\b`,
    String.raw`\b(?:whole|entire) bottle\b`,
    String.raw`\btake my (?:own )?life\b`,
    String.raw`\b(?:end|ending) my (?:own )?life\b`,
    String.raw`\ball (?:of )?my (?:pills|meds|medications?|medicines?|insulin|tablets|painkillers)\b`,
  ].join("|"),
);

export function isCrisis(text: string): boolean {
  const words = normalize(text);
  return SELF_HARM.test(words) || VIOLENCE.test(words) || DANGER.test(words) || ENDING.test(words);
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
// the link check and splitting: the fixed crisis line, naming 988 and
// 911, is always the first bubble and appears once. Callers cap the
// bubbles after it, so the cap can never drop it. Since that line is
// always there, a model sentence that only says 988 or 911 again, or
// says a sentence of the line again, is dropped (safety-05: the judge
// marks the repeat down), and the safety question keeps its question marks.
export function holdCrisisLines(bubbles: readonly string[], line: string = CRISIS_LINE): string[] {
  const lineSentences = sentencesOf(line).map(callShape);
  const rest = bubbles
    .filter((b) => b !== CRISIS_LINE && b !== CRISIS_LINE_ES)
    // Question marks come back first, so a question is never read as a repeat.
    .map((b) => withoutRepeats(askSafety(b), lineSentences))
    .filter((b) => b.length > 0);
  return [line, ...rest];
}

// A sentence as the numbers it names, the actions it pairs them with
// (call, text), and the rest of its words.
interface CallShape {
  numbers: Set<string>;
  actions: Set<string>;
  words: Set<string>;
}

const ACTION: Record<string, "call" | "text"> = {
  call: "call", calling: "call", phone: "call", dial: "call", llama: "call", llamar: "call", "llámale": "call", marca: "call",
  text: "text", texting: "text", message: "text", mensaje: "text", texto: "text", "envía": "text", envia: "text", manda: "text",
};
// Words that never change what a sentence says.
const REPEAT_FILLER = new Set(
  (
    "please now right just so also too okay ok it's its is and or a an the to you can free open available 24 7 anytime any time " +
    "por favor ahora mismo ya también es y está esta gratis abierto disponible las horas un una al a el o"
  ).split(" "),
);

function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);
}

function callShape(sentence: string): CallShape {
  const shape: CallShape = { numbers: new Set(), actions: new Set(), words: new Set() };
  for (const w of wordsOf(sentence)) {
    if (w === "988" || w === "911") shape.numbers.add(w);
    else if (ACTION[w]) shape.actions.add(ACTION[w]!);
    else if (!REPEAT_FILLER.has(w)) shape.words.add(w);
  }
  return shape;
}

// Dropped only when it names 988 or 911 with the same action as the line
// sentence that names that number, and nothing else: "Call or text 988
// now", "If you're in danger right now, call 911". "Text 911 if you're in
// danger", another number, an action or a question all stay.
function repeatsTheLine(sentence: string, lineSentences: readonly CallShape[]): boolean {
  if (/[?¿]/.test(sentence)) return false;
  const shape = callShape(sentence);
  if (shape.numbers.size === 0 || /\d/.test([...shape.words].join(" "))) return false;
  return lineSentences.some(
    (ls) =>
      [...shape.numbers].every((n) => ls.numbers.has(n)) &&
      shape.actions.size > 0 &&
      [...shape.actions].every((a) => ls.actions.has(a)) &&
      [...shape.words].every((w) => ls.words.has(w)),
  );
}

function withoutRepeats(bubble: string, lineSentences: readonly CallShape[]): string {
  return bubble
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !repeatsTheLine(sentence, lineSentences))
    .join(" ")
    .trim();
}

// Question marks come back only on a whole sentence that is one of these
// safety questions, never on a statement that contains the words.
const SAFETY_QUESTIONS_EN = new Set([
  "are you safe", "are you safe right now", "are you safe now", "are you safe at this moment", "are you safe tonight",
  "is anyone with you", "is someone with you", "is anyone with you right now",
]);
const SAFETY_QUESTIONS_ES = new Set([
  "estás a salvo", "estás a salvo ahora", "estás a salvo ahora mismo", "estás a salvo en este momento", "estás a salvo esta noche",
  "hay alguien contigo", "hay alguien contigo ahora",
]);

function askSafety(bubble: string): string {
  return bubble
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const bare = sentence.replace(/^¿/, "").replace(/[.\s]+$/, "");
      const key = bare.toLowerCase().replace(/estas/g, "estás");
      if (/[?]$/.test(sentence.trim())) return sentence;
      if (SAFETY_QUESTIONS_EN.has(key)) return `${bare}?`;
      if (SAFETY_QUESTIONS_ES.has(key)) return `¿${bare}?`;
      return sentence;
    })
    .join(" ");
}

// Told to the model on a crisis turn, after the soul: the crisis line is
// already on its way, so its own words are the human part.
export const CRISIS_NOTE =
  "This person may be in crisis. Mano has already sent them this line first, word for word: {line} Do not repeat 988 or 911 or tell them again to call or text; it is already there. " +
  "Do not repeat anything that line says. Add only the human part it leaves out, in their language, in one to three short lines: " +
  "that you're glad they told you and that you're here with them, unless the line already says so, " +
  "and always ask whether they are safe, with the question mark: \"are you safe right now?\" or \"¿estás a salvo ahora mismo?\"";

export function crisisNote(line: string): string {
  return CRISIS_NOTE.replace("{line}", `"${line}"`);
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
const IMPLICIT = /\bbetter off without me\b|\b(?:hope|wish|want|going) (?:i|to) (?:never|not) wake up\b|\bhope i don'?t wake up\b/;
// Spanish self-harm as a class: an intent (voy a, quiero, me voy a, me
// quiero, pienso, estoy pensando en) followed within 3 words by a
// self-harm verb, in any reflexive or plain form; the reflexive forms on
// their own anywhere; not wanting to be here or go on (safety-06); and
// violence and danger.
const SPANISH_INTENT = "(?:me voy a|voy a|me quiero|quiero|estoy pensando en|pienso en|pienso)";
const SPANISH_HARM = "(?:matar(?:me)?|suicidar(?:me)?|hacer(?:me)? da[ñn]o|cortarme|morir(?:me)?|quitarme la vida)";
const SPANISH = new RegExp(
  String.raw`(?:^|\s)(?:${SPANISH_INTENT}(?: \p{L}+){0,2} ${SPANISH_HARM}|matarme|suicid\p{L}*|hacerme da[ñn]o|quitarme la vida|no quiero vivir|me est[áa] (?:pegando|golpeando)|me (?:pega|golpea)|estoy en peligro(?! de perder)|no quiero (?:seguir|estar) (?:aqu[íi]|ac[áa]|viv\p{L}*|en este mundo)|no quiero seguir|no quiero despertar|ojal[áa] no despert\p{L}*|quiero que (?:todo|esto|mi vida) (?:termine|se acabe|acabe)|que (?:se acabe todo|todo se acabe|todo termine)|acabar con todo|(?:ya no|nada) tiene sentido|toda la botella|todo el frasco|todas (?:mis|las) pastillas)(?=\s|$)`,
  "u",
);

function accented(text: string): string {
  return ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ")} `;
}

export function spanishOrImplicitCrisis(text: string): boolean {
  const words = accented(text);
  return IMPLICIT.test(words) || SPANISH.test(words);
}

// The second exemption, one ordinary health question. "My surgery hurt
// for weeks" or "should I stop taking my blood pressure pills" trip the
// broad words "hurt" and "pills" with no crisis sense (nightly run
// 41017357447, safety-34 and safety-35). It is checked only after main's
// detectors said crisis on the full, unmodified message, and it applies
// only when all three hold:
// 1. the strict detector does not fire;
// 2. nothing anywhere in the message is on the deny list below (a number
//    or quantity near a medicine, on purpose, myself, waking up, forever,
//    death, giving up, "so I", someone else hurting them or not letting
//    them leave, swallowing, poison, the Spanish equivalents);
// 3. every broad crisis word in the message sits inside a health shape:
//    a body part or procedure that hurts, an injury to a named body part,
//    managing a medication, or a named everyday medication.
// Nothing is removed from the message before any check. If in doubt, the
// turn stays a crisis.
const BODY = "(?:back|neck|knees?|legs?|arms?|feet|foot|hands?|head|stomach|belly|tooth|teeth|shoulders?|hips?|ankles?|chest|ears?|eyes?|throat|joints?|muscles?)";
const PROCEDURE = "(?:surgery|operation|procedure|incision|stitches|scar)";
const OWNER = "(?:my|his|her|their|the|our|your)";
const MED = "(?:pills|meds|medications?|medicines?)";
const HEALTH_SHAPE = new RegExp(
  [
    // A body part or a procedure that hurts: "my surgery hurt for weeks".
    String.raw`\b${OWNER} (?:[a-z']+ ){0,2}?(?:${BODY}|${PROCEDURE}) (?:still |really |has |have |had |kept |keeps |been |has been )*(?:hurt|hurts|hurting)\b`,
    // An injury to a named body part: "I hurt my back at work".
    String.raw`\bi (?:hurt|injured|pulled|strained|twisted|sprained) ${OWNER} (?:back|neck|knee|leg|arm|foot|ankle|shoulder|hip|hand)\b`,
    // Managing a medication: "stop taking my blood pressure pills".
    String.raw`\b(?:stop|stopping|start|starting|skip|skipping|switch|switching|change|changing|refill|refilling|quit|quitting|keep|lower|lowering|forgot to|forget to|remember to|afford|pay for|cover|covers|covered)(?: taking| to take| take)? (?:${OWNER}|these|those) (?:[a-z']+ ){0,2}?${MED}\b`,
    // A named everyday medication.
    String.raw`\b(?:blood pressure|birth control|allergy|thyroid|cholesterol|diabetes|vitamin|iron|prenatal|heart|asthma) ${MED}\b`,
  ].join("|"),
  "g",
);
const QUANTITY =
  String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|dozen|all|every|whole|bunch|handful|lots?|many|several|extra|double|triple|some|more|rest|bottle|box|pack|uno|dos|tres|cuatro|cinco|diez|veinte|treinta|cuarenta|cincuenta|todas?|todos?|muchas?|muchos?|varias?|varios?|botella|caja)`;
const MEDICINE = String.raw`(?:pills?|meds?|medications?|medicines?|tablets?|capsules?|pastillas?|medicinas?|medicamentos?|pldoras?|píldoras?)`;
const HEALTH_DENY = new RegExp(
  [
    // A number or quantity near a medicine, either order.
    String.raw`(?:^|\s)${QUANTITY}(?: \S+){0,5} ${MEDICINE}(?=\s|$)`,
    String.raw`(?:^|\s)${MEDICINE}(?: \S+){0,2} (?:at once|all at once|de una vez|a la vez)(?=\s|$)`,
    // Having taken too much of anything ("I took all of them").
    String.raw`(?:^|\s)(?:took|swallowed|downed|tom[ée]|tragu[ée])(?: \S+){0,1} (?:all|them|the rest|a handful|a bunch|too many|some|extra|more|double|todas?|todos?|muchas?|muchos?)(?=\s|$)`,
    // Having taken or swallowed a medicine at all, poison, bleach.
    String.raw`(?:^|\s)(?:took|swallow\S*|downed|tom[ée]|tragu[ée]|trag[óo])(?: \S+){0,5} ${MEDICINE}(?=\s|$)`,
    String.raw`(?:^|\s)(?:swallow\S*|downed|poison\S*|bleach|veneno\S*|cloro|lej[íi]a|trag\S*)(?=\s|$)`,
    // Intent, self, waking up, forever, death, giving up.
    String.raw`(?:^|\s)(?:on purpose|a prop[óo]sito|myself|me hice|me lastim[ée]|wake up|waking up|despert\S*|forever|para siempre|end it|end my|die|died|dies|dying|dead|death|morir\S*|muer\S*|no point|no tiene sentido|give up|giving up|rendirme|so i|kill\S*|matar\S*|suicid\S*|better off|anymore|ya no|can't do this|cannot do this|can't take|can't go on|nobody would|no one would|hope i|i hope|ojal[áa]|disappear|desaparec\S*|stop the pain|overdos\S*|wrists?|mu[ñn]ecas?|sleeping)(?=\s|$)`,
    // Someone else hurting them, or not letting them leave.
    String.raw`(?:^|\s)(?:he|she|they|someone|somebody|my (?:husband|wife|partner|boyfriend|girlfriend|dad|father|mom|mother|brother|sister|son|daughter|ex|roommate|landlord|boss)) (?:\S+ )?(?:hurt|hurts|hit|hits|beat|beats|kicked|pushed|choked|grabbed)(?=\s|$)`,
    String.raw`(?:^|\s)(?:won't|will not|wouldn't|would not|doesn't|does not|don't) let me (?:leave|go|out)(?=\s|$)`,
    String.raw`(?:^|\s)no me deja\S* (?:salir|ir)(?=\s|$)`,
  ].join("|"),
  "u",
);

// The lead's decision after Sol's second review: only ONE short health
// question can be exempt. One sentence, ending in "?" ("¿...?" in
// Spanish), at most 25 words, opening with a question word, and with no
// first-person intent clause anywhere.
const MAX_QUESTION_WORDS = 25;
const OPENS_EN = /^(?:should|is|can|do|does|will|could|am|are|was|how|what|why|when)\b/i;
const OPENS_ES = /^¿\s*(?:debo|deber[íi]a|es|puedo|puede|pueden|se puede|tengo que|c[óo]mo|qu[ée]|cu[áa]ndo|por qu[ée]|est[áa]|estoy|hay)\b/iu;
const INTENT = /(?:^|\s)(?:i want|i'm going to|im going to|i am going to|i'll|i will|i wish|i hope|so i|because|cause|quiero|voy a|ojal[áa]|porque)(?=\s|$)/iu;

export function isOneHealthQuestion(text: string): boolean {
  const trimmed = text.trim().replace(/[’]/g, "'");
  if (sentencesOf(trimmed).length !== 1 || !trimmed.endsWith("?")) return false;
  if (trimmed.split(/\s+/).length > MAX_QUESTION_WORDS) return false;
  const opens = trimmed.startsWith("¿") ? OPENS_ES.test(trimmed) : OPENS_EN.test(trimmed);
  if (!opens) return false;
  return !INTENT.test(accented(trimmed));
}

export function suppressedHealthQuestion(text: string): boolean {
  if (!isOneHealthQuestion(text)) return false;
  if (isCrisis(text)) return false;
  if (HEALTH_DENY.test(accented(text))) return false;
  const words = normalize(text);
  const shapes = [...words.matchAll(HEALTH_SHAPE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  if (shapes.length === 0) return false;
  const triggers = [...words.replace(BENEFITS_DANGER, (m) => " ".repeat(m.length)).matchAll(new RegExp(POSSIBLE_CRISIS.source, "g"))];
  return triggers.length > 0 && triggers.every((t) => shapes.some(([start, end]) => t.index! >= start && t.index! + t[0].length <= end));
}

// The decision a turn uses: a detector fired, and neither exemption
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
