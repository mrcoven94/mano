// Crisis floor. The soul tells the model what to do in a crisis; this
// is the deterministic net underneath it. Detection is never the only
// protection: every busy, over-limit and failure reply carries
// SAFETY_LINE whether or not isCrisis fires. isCrisis routes a message
// away from the deep path and makes its reply name 988 and 911.

export const CRISIS_LINE =
  "I'm really glad you told me. Please call or text 988 right now, they're there 24/7 and it's free. " +
  "If you're in danger right now, call 911. I'm here too.";

// One sentence, added to every reply Mano sends without the model.
export const SAFETY_LINE = "If you're in danger or thinking about hurting yourself, call 911 or text 988.";

// Self-harm and violence count anywhere. "Danger" and "unsafe" count
// only outside talk of benefits, money or housing, so "in danger of
// losing my benefits" stays a benefits question.
const SELF_HARM =
  /\b(?:suicid(?:e|al)|kill(?:ing)? myself|end (?:my life|it all)|(?:want|wanna) to die|wanna die|better off dead|(?:hurt|hurting|harm|harming|cut|cutting) myself|self harm|(?:don'?t|do not) want to (?:be here|live))\b/;
const VIOLENCE =
  /\b(?:(?:hit|hits|hitting|beat|beats|beating|hurt|hurts|hurting|choked?|choking|kick(?:s|ed|ing)?|attack(?:s|ed|ing)?|abus(?:es|ed|ing)) (?:me|us|my (?:kids?|children|son|daughter|baby))|(?:being|been|was|got) (?:abused|hit|beaten|attacked|choked)|abusive|domestic (?:abuse|violence)|(?:threaten(?:s|ed)?|going|gonna|wants?|tried|trying) to kill (?:me|us|myself|him|her|them)|kill me)\b/;
const DANGER = /\b(?:immediate danger|in danger(?! of\b)|(?:i'?m|i am|feel|felt|not) (?:unsafe|not safe)|unsafe at home|not safe at home|(?:i'?m|i am) not safe|(?:don'?t|do not) feel safe)\b/;
const MONEY_CONTEXT = /\b(?:benefits?|snap|food stamps|medicaid|wic|tanf|rent|evict(?:ed|ion)?|landlord|lease|apartment|housing|job|money|budget|bills?|debt|owe|coverage|payment|losing|lose)\b/;

export function isCrisis(text: string): boolean {
  const words = ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `;
  if (SELF_HARM.test(words) || VIOLENCE.test(words)) return true;
  return DANGER.test(words) && !MONEY_CONTEXT.test(words);
}

export function namesCrisisLines(reply: string): boolean {
  return /\b988\b/.test(reply) && /\b911\b/.test(reply);
}

// The reply a crisis turn sends: the model's own words when they name
// both lines, otherwise CRISIS_LINE first.
export function crisisFloor(reply: string): string {
  return namesCrisisLines(reply) ? reply : `${CRISIS_LINE} ${reply}`.trim();
}

// The last check on a crisis turn's outgoing bubbles, after the guard,
// the link check and truncation: if either number is gone, CRISIS_LINE
// goes first. Callers cap the bubble count after this, so it is never
// the line that gets cut.
export function holdCrisisLines(bubbles: readonly string[]): string[] {
  return namesCrisisLines(bubbles.join(" ")) ? [...bubbles] : [CRISIS_LINE, ...bubbles];
}
