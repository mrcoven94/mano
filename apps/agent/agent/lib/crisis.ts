// Crisis detector: plain keyword screen on inbound text. A match does
// not block the turn; it tells the model to lead with the crisis line
// and skip everything else. Quality (LAP-567) has no shared detector
// merged yet; when it lands, this defers to it. Never logs the text.
const CRISIS_PATTERNS: RegExp[] = [
  /\bkill myself\b/i,
  /\bkilling myself\b/i,
  /\bend my life\b/i,
  /\bending my life\b/i,
  /\bend it all\b/i,
  /\bsuicid/i,
  /\bself[-\s]?harm\b/i,
  /\bhurt myself\b/i,
  /\bhurting myself\b/i,
  /\bwant to die\b/i,
  /\bgoing to die\b/i,
  /\bbetter off dead\b/i,
  /\bno reason to live\b/i,
  /\bcan.?t go on\b/i,
  /\bgive up on life\b/i,
];

export const CRISIS_LINE =
  "If you might act on these thoughts, call or text 988 now (call 911 if someone is in danger). You matter, and help is there any time.";

export function detectCrisis(text: string): boolean {
  return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
}
