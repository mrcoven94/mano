// Parses a free-text answer to a yes-or-no approval question. Anything
// unclear returns null and the approval fails closed: the model asks
// again rather than guessing.
const YES = [/^\s*y(es|ep|up|a)?\s*[.!]?\s*$/i, /^\s*ok(ay)?\s*[.!]?\s*$/i, /^\s*sure\s*[.!]?\s*$/i, /^\s*do it\s*[.!]?\s*$/i, /^\s*go ahead\s*[.!]?\s*$/i, /^\s*approve(d)?\s*[.!]?\s*$/i, /^\s*confirmed?\s*[.!]?\s*$/i, /^\s*1\s*$/];
const NO = [/^\s*no?(pe)?\s*[.!]?\s*$/i, /^\s*don'?t\s*[.!]?\s*$/i, /^\s*stop\s*[.!]?\s*$/i, /^\s*cancel(led)?\s*[.!]?\s*$/i, /^\s*never mind\s*[.!]?\s*$/i, /^\s*not yet\s*[.!]?\s*$/i, /^\s*2\s*$/];

export type Decision = "yes" | "no";

export function parseDecision(text: string): Decision | null {
  const clean = text.trim();
  if (YES.some((pattern) => pattern.test(clean))) return "yes";
  if (NO.some((pattern) => pattern.test(clean))) return "no";
  return null;
}
