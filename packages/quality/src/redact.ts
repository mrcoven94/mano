// Redaction of model and provider names from anything staff-visible. The bench
// stores judge IDs and raw answers internally; every string the staff page
// renders passes through stripModelNames first.

const PATTERNS: RegExp[] = [
  // Bare judge: prefixed IDs first, before family patterns split them.
  /\bjudge:[a-z0-9_.-]+/gi,
  // Model families with optional variant and version: Muse Spark 1.3, gpt-4o, claude-3.
  /\bmuse(?:[-\s]?(spark|wonder|glimmer))?(?:[-\s]?\d+(?:\.\d+)?)?(?:-contributor)?\b/gi,
  /\bgpt(?:[-\s]?\d[o0-9a-z.]*)?\b/gi,
  /\bclaude(?:[-\s]?\d(?:\.\d+)?)?\b/gi,
  /\bgemini(?:[-\s]?\d(?:\.\d+)?(?:\s*(pro|flash|ultra))?)?\b/gi,
  /\bllama(?:[-\s]?\d+)?\b/gi,
  // Providers and model-adjacent vendors.
  /\bopenai\b/gi,
  /\banthropic\b/gi,
  /\bgoogle(?:\s+deepmind)?\b/gi,
  /\bxai\b/gi,
  /\bmeta\b/gi,
  /\bdeepgram\b/gi,
  // Bare model IDs: vedette-spark-1.3-contributor and similar.
  /\b[a-z]+-(?:spark|wonder|glimmer|contributor)(?:-[a-z0-9.]+)*\b/gi,
];

export function stripModelNames(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[model]");
  }
  return out.replace(/\[model\](?:\s*\[model\])+/g, "[model]");
}
