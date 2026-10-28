// Redaction for anything going to logs or to outside graders. Structural
// patterns (emails, phones, ID numbers, case numbers, birth dates, street
// addresses) are caught by shape. Names and employers have no shape, so the
// caller passes the ones it knows about and they are matched literally.
import { canonicalRecipient } from "./rules.js";
import type { CheckInput } from "./types.js";

export interface KnownEntities {
  names?: string[];
  employers?: string[];
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE =
  /\(?(?:\+?1[-.\s]?)?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LABELED_ID =
  /\b(?:SSN|social security|ID|DL|driver(?:'s)? license|passport)\s*(?:number|no\.?|#)?\s*:?\s*[\w-]{4,}/gi;
const CASE_NUMBER =
  /\bcase\s*(?:(?:number|no\.?|#)\s*:?\s*)?[\w-]*\d[\w-]*/gi;
const RECEIPT_NUMBER = /\b[A-Z]{3}\d{8,13}\b/g;
const DATE_OF_BIRTH =
  /\b(?:DOB|date of birth|born)\s*:?\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})/gi;
const JSON_DATE_OF_BIRTH =
  /("(?:dob|date[_\s]?of[_\s]?birth|birth_?date|birthdate)"\s*:\s*")[^"]*(")/gi;
const STREET_ADDRESS =
  /\b\d{1,5}\s+[A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Ter|Terrace)\b(?:\s+(?:Apt|Unit|#)\s*[\w-]+)?/gi;
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;
const URL = /https?:\/\/[^\s"']+/gi;

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
  out = out.replace(JSON_DATE_OF_BIRTH, '$1[DATE OF BIRTH]$2');
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

function replaceLiteral(haystack: string, needle: string, label: string): string {
  if (needle.trim() === "") return haystack;
  return haystack.replace(new RegExp(escapeRegExp(needle), "gi"), label);
}

// Numbered placeholders for destinations found in free text, assigned in
// first-appearance order so the same value always gets the same label and
// different values stay distinguishable.
class DestinationLabels {
  private readonly labels = new Map<string, string>();
  private email = 0;
  private phone = 0;
  private url = 0;

  labelAll(text: string): string {
    let out = text.replace(URL, (match) => this.label(match, "url"));
    out = out.replace(EMAIL, (match) => this.label(match, "email"));
    out = out.replace(PHONE, (match) => this.label(match, "phone"));
    return out;
  }

  private label(value: string, kind: "email" | "phone" | "url"): string {
    const key = `${kind}:${value.toLowerCase()}`;
    const existing = this.labels.get(key);
    if (existing !== undefined) return existing;
    const next =
      kind === "email"
        ? `EMAIL-${(this.email += 1)}`
        : kind === "phone"
          ? `PHONE-${(this.phone += 1)}`
          : `URL-${(this.url += 1)}`;
    const placeholder = `[${next}]`;
    this.labels.set(key, placeholder);
    return placeholder;
  }
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = mapStrings(entry, map);
    }
    return out;
  }
  return value;
}

// Redact a full check input before it leaves Mano for the guardian model.
// The recipient becomes [RECIPIENT] everywhere it appears, other consented
// destinations become [OTHER-1], [OTHER-2] and so on, and emails, phones and
// links in free text get numbered labels, so the model can still compare
// destinations without seeing their values. Everything else structural goes
// through redact(). IDs, kinds, the action type and the origin pass through.
export function redactCheckInput(input: CheckInput, known?: KnownEntities): CheckInput {
  const clone = structuredClone(input);
  const labels = new DestinationLabels();
  const recipient = canonicalRecipient(clone.action.recipient);
  const others = new Map<string, string>();
  const otherLabel = (raw: string): string => {
    const canonical = canonicalRecipient(raw);
    if (canonical === recipient) return "[RECIPIENT]";
    const existing = others.get(canonical);
    if (existing !== undefined) return existing;
    const placeholder = `[OTHER-${others.size + 1}]`;
    others.set(canonical, placeholder);
    return placeholder;
  };
  const destinations = [
    clone.action.recipient,
    ...clone.consents.map((consent) => consent.recipient),
  ];
  const scrub = (text: string): string => {
    let out = text;
    for (const destination of destinations) {
      out = replaceLiteral(out, destination, otherLabel(destination));
    }
    out = labels.labelAll(out);
    return redact(out, known);
  };
  clone.action.recipient = scrub(clone.action.recipient);
  clone.action.purpose = scrub(clone.action.purpose);
  clone.action.payload = mapStrings(clone.action.payload, scrub);
  for (const source of clone.sources) {
    if (source.quote !== undefined) source.quote = scrub(source.quote);
  }
  for (const consent of clone.consents) {
    consent.recipient = scrub(consent.recipient);
    consent.purpose = scrub(consent.purpose);
  }
  return clone;
}
