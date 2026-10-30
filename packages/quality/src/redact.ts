// Redaction of model and provider names from anything staff-visible. The bench
// stores judge IDs and raw answers internally; every string the staff page
// renders passes through stripModelNames first. One list drives every pattern
// so a new model is one line, and the test names each entry.

// Model families. Each matches with an optional variant and version:
// Muse Spark 1.3, muse-wonder, gpt-4o, claude-3-5, gemini 2.0 flash.
const MODEL_FAMILIES = [
  { name: "muse", variants: ["spark", "wonder", "glimmer"] },
  { name: "gpt", variants: [] },
  { name: "claude", variants: [] },
  { name: "gemini", variants: [] },
  { name: "llama", variants: [] },
  { name: "grok", variants: [] },
  { name: "mistral", variants: [] },
  { name: "mixtral", variants: [] },
  // Deliberately absent: command, palm, falcon. Those bare words appear in
  // ordinary answers far more often than as model names, and stripping them
  // would mangle the staff page.
];

// Standalone product names. Each matches exactly (case-insensitive); bare
// "sam" is a person's name and is never stripped, only "SAM 3" with a version.
const PRODUCT_NAMES = [
  "SAM 3.1",
  "SAM 3",
  "Voice Transcribe",
  "Muse Voice Transcribe",
  "Image Generation",
  "Computer Use",
];

// Providers and model-adjacent vendors, matched as whole words.
const PROVIDERS = [
  "openai",
  "anthropic",
  "google deepmind",
  "google",
  "xai",
  "meta",
  "microsoft",
  "amazon",
  "cohere",
  "deepgram",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function familyPattern(family: { name: string; variants: string[] }): RegExp {
  const name = escapeRegExp(family.name);
  const variant = family.variants.length > 0 ? `(?:[\\s-]?(?:${family.variants.join("|")}))?` : "";
  // Optional version in any separator style: 4o, 3.5, 1.3, 2.0 flash.
  return new RegExp(`\\b${name}${variant}(?:[\\s-]?\\d[o0-9a-z.]*(?:[\\s-]?(?:pro|flash|ultra|lite|mini|turbo|max|nano))?)?(?:-contributor)?\\b`, "gi");
}

function phrasePattern(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(phrase).replace(/\s+/g, "\\s+")}\\b`, "gi");
}

function buildPatterns(): RegExp[] {
  const patterns: RegExp[] = [
    // Judge-prefixed IDs first, before family patterns split them.
    /\bjudge:[a-z0-9_.-]+/gi,
    // Bare model IDs: vedette-spark-1.3-contributor and similar.
    /\b[a-z]+-(?:spark|wonder|glimmer|contributor)(?:-[a-z0-9.]+)*\b/gi,
  ];
  // Longer phrases first so "SAM 3.1" wins over "SAM 3".
  const phrases = [...PRODUCT_NAMES].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) patterns.push(phrasePattern(phrase));
  for (const family of MODEL_FAMILIES) patterns.push(familyPattern(family));
  for (const provider of PROVIDERS) patterns.push(phrasePattern(provider));
  return patterns;
}

const PATTERNS = buildPatterns();

export function stripModelNames(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[model]");
  }
  return out.replace(/\[model\](?:\s*\[model\])+/g, "[model]");
}

export interface StaffCase {
  caseId: string;
  suite: string;
  answer: { text: string };
  checks: { id: string; pass: boolean; detail?: string }[];
  judge: { helpful: number; accurate: number; plain: number; warm: number; pass: boolean; reason: string } | null;
}

// The staff page's cleaning step, tested here: strip model names from the
// answer, every check detail, and the judge reason before render.
export function scrubStaffCase<T extends StaffCase>(c: T): T {
  return {
    ...c,
    answer: { text: stripModelNames(c.answer.text) },
    checks: c.checks.map((r) => ({ ...r, detail: r.detail === undefined ? undefined : stripModelNames(r.detail) })),
    judge: c.judge ? { ...c.judge, reason: stripModelNames(c.judge.reason) } : null,
  };
}
