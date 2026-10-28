// Redaction for anything going to logs or to outside graders. Structural
// patterns (emails, phones, ID numbers, case numbers, birth dates, street
// addresses) are caught by shape. Names and employers have no shape, so the
// caller passes the ones it knows about and they are matched literally.

export interface KnownEntities {
  names?: string[];
  employers?: string[];
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE =
  /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LABELED_ID =
  /\b(?:SSN|social security|ID|DL|driver(?:'s)? license|passport)\s*(?:number|no\.?|#)?\s*:?\s*[\w-]{4,}/gi;
const CASE_NUMBER =
  /\bcase\s*(?:(?:number|no\.?|#)\s*:?\s*)?[\w-]*\d[\w-]*/gi;
const RECEIPT_NUMBER = /\b[A-Z]{3}\d{8,13}\b/g;
const DATE_OF_BIRTH =
  /\b(?:DOB|date of birth|born)\s*:?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/gi;
const STREET_ADDRESS =
  /\b\d{1,5}\s+[A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Ter|Terrace)\b(?:\s+(?:Apt|Unit|#)\s*[\w-]+)?/g;
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, known?: KnownEntities): string {
  let out = text;
  out = out.replace(EMAIL, "[EMAIL]");
  // Case and receipt numbers before phones so digit runs keep their label.
  out = out.replace(CASE_NUMBER, "[CASE NUMBER]");
  out = out.replace(RECEIPT_NUMBER, "[CASE NUMBER]");
  out = out.replace(SSN, "[ID]");
  out = out.replace(LABELED_ID, "[ID]");
  out = out.replace(PHONE, "[PHONE]");
  out = out.replace(DATE_OF_BIRTH, "[DATE OF BIRTH]");
  out = out.replace(STREET_ADDRESS, "[ADDRESS]");
  out = out.replace(ZIP_CODE, "[ADDRESS]");

  const names = [...(known?.names ?? [])].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (name.trim() === "") continue;
    out = out.replace(new RegExp(escapeRegExp(name), "gi"), "[NAME]");
  }
  const employers = [...(known?.employers ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  for (const employer of employers) {
    if (employer.trim() === "") continue;
    out = out.replace(new RegExp(escapeRegExp(employer), "gi"), "[EMPLOYER]");
  }
  return out;
}
