// Crisis floor. The soul tells the model what to do in a crisis; this
// is the deterministic net underneath it. When the person's text
// matches, the reply skips the deep path and must name 988 and 911, or
// CRISIS_LINE goes first. Patterns are first person on purpose: "this
// deadline is killing me" and "in danger of losing my benefits" must
// not match, and each pattern is tested both ways.

export const CRISIS_LINE =
  "I'm really glad you told me. Please call or text 988 right now, they're there 24/7 and it's free. " +
  "If you're in danger right now, call 911. I'm here too.";

const CRISIS_PATTERNS = [
  "suicide",
  "suicidal",
  "kill myself",
  "killing myself",
  "end my life",
  "end it all",
  "want to die",
  "wanna die",
  "better off dead",
  "hurt myself",
  "hurting myself",
  "harm myself",
  "harming myself",
  "self harm",
  "cut myself",
  "cutting myself",
  "don't want to be here",
  "dont want to be here",
  "do not want to be here",
  "don't want to live",
  "dont want to live",
  "i'm in danger",
  "im in danger",
  "i am in danger",
  "i'm not safe",
  "im not safe",
  "i am not safe",
  "not safe at home",
  "don't feel safe",
  "dont feel safe",
  "do not feel safe",
  "he hit me",
  "she hit me",
  "they hit me",
  "he hits me",
  "she hits me",
  "hurting me",
  "beats me",
];

export function isCrisis(text: string): boolean {
  const words = ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ")} `;
  return CRISIS_PATTERNS.some((pattern) => words.includes(` ${pattern} `));
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
