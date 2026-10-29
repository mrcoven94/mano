// Case IDs come from the resident's client. Every boundary that accepts
// one (the person agent's consent calls and share delivery, the org
// agent's consent intake) holds it to this pattern, so a URL or other
// free text never becomes a case ID.
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const CASE_ID_RULE =
  "Case ID must be 1 to 64 letters, digits, hyphens or underscores, starting with a letter or digit.";

export function isCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID.test(value);
}
