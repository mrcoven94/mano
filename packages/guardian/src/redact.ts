// Redaction for anything going to logs or to outside graders. Structural
// patterns (emails, phones, ID numbers, case numbers, birth dates, street
// addresses) are caught by shape. Names, employers and many other details
// have no reliable shape, so the caller passes the values it knows about
// and each is matched literally, before any pattern can split it.
import { PAYLOAD_SCHEMAS, canonicalRecipient } from "./rules.js";
import type { CheckInput, ModelRequest } from "./types.js";

export interface KnownEntities {
  names?: string[];
  employers?: string[];
  addresses?: string[];
  phones?: string[];
  emails?: string[];
  datesOfBirth?: string[];
  caseNumbers?: string[];
}

type EntityKind = keyof KnownEntities;

const KNOWN_LABELS: Record<EntityKind, string> = {
  names: "[NAME]",
  employers: "[EMPLOYER]",
  addresses: "[ADDRESS]",
  phones: "[PHONE]",
  emails: "[EMAIL]",
  datesOfBirth: "[DATE OF BIRTH]",
  caseNumbers: "[CASE NUMBER]",
};

// The sandbox portal's renewal fields (PORTAL_HOUSEHOLD in Engine's
// executors). A personal field reaches the model only as its kind's label
// and its value joins the known entities, so it is caught anywhere else in
// the request too. Number fields reach the model as numbers, so it can
// judge whether a household size or income makes sense.
const SUBMIT_FORM_FIELDS: Record<string, EntityKind | "number"> = {
  fullName: "names",
  dateOfBirth: "datesOfBirth",
  address: "addresses",
  phone: "phones",
  householdSize: "number",
  monthlyIncome: "number",
};

const PLAIN_NUMBER = /^-?\d{1,7}(?:\.\d{1,2})?$/;

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
const BARE_ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const BARE_US_DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const STREET_ADDRESS =
  /\b\d{1,5}\s+[A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Ter|Terrace)\b(?:\s+(?:Apt|Unit|#)\s*[\w-]+)?/gi;
const ZIP_CODE = /\b\d{5}(?:-\d{4})?\b/g;
const URL = /https?:\/\/[^\s"']+/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One pass over every known value, longest first, so a longer value wins
// where two overlap and a label already written is never matched again.
function replaceKnown(text: string, known: KnownEntities | undefined): string {
  const needles = (Object.keys(KNOWN_LABELS) as EntityKind[])
    .flatMap((kind) =>
      (known?.[kind] ?? [])
        .map((value) => value.trim())
        .filter((value) => value !== "")
        .map((value) => ({ value, label: KNOWN_LABELS[kind] })),
    )
    .sort((a, b) => b.value.length - a.value.length);
  if (needles.length === 0) return text;
  // One capture group per value, so the group that matched names its label.
  const pattern = needles.map(({ value }) => `(${escapeRegExp(value)})`).join("|");
  return text.replace(new RegExp(pattern, "gi"), (...args: unknown[]) => {
    const index = args.slice(1, needles.length + 1).findIndex((group) => group !== undefined);
    return needles[index]?.label ?? "[REDACTED]";
  });
}

export function redact(text: string, known?: KnownEntities): string {
  let out = replaceKnown(text, known);
  out = out.replace(EMAIL, "[EMAIL]");
  // Case and receipt numbers before phones so digit runs keep their label.
  out = out.replace(CASE_NUMBER, "[CASE NUMBER]");
  out = out.replace(RECEIPT_NUMBER, "[CASE NUMBER]");
  out = out.replace(SSN, "[ID]");
  out = out.replace(LABELED_ID, "[ID]");
  out = out.replace(PHONE, "[PHONE]");
  out = out.replace(DATE_OF_BIRTH, "[DATE OF BIRTH]");
  out = out.replace(JSON_DATE_OF_BIRTH, '$1[DATE OF BIRTH]$2');
  out = out.replace(BARE_ISO_DATE, "[DATE]");
  out = out.replace(BARE_US_DATE, "[DATE]");
  out = out.replace(STREET_ADDRESS, "[ADDRESS]");
  out = out.replace(ZIP_CODE, "[ADDRESS]");
  return out;
}

function replaceDestination(haystack: string, needle: string, label: string): string {
  if (needle.trim() === "") return haystack;
  const want = canonicalRecipient(needle);
  return haystack.replace(new RegExp(escapeRegExp(needle), "gi"), (match) =>
    canonicalRecipient(match) === want ? label : match,
  );
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
    // Case-sensitive: values the rules treat as distinct destinations must
    // never share a label.
    const key = `${kind}:${value}`;
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

export function mergeEntities(
  ...sets: (KnownEntities | undefined)[]
): KnownEntities {
  const merged: KnownEntities = {};
  for (const set of sets) {
    for (const kind of Object.keys(KNOWN_LABELS) as EntityKind[]) {
      const values = set?.[kind] ?? [];
      if (values.length > 0) merged[kind] = [...(merged[kind] ?? []), ...values];
    }
  }
  return merged;
}

function formEntities(form: Record<string, unknown>): KnownEntities {
  const found: KnownEntities = {};
  for (const [field, kind] of Object.entries(SUBMIT_FORM_FIELDS)) {
    if (kind === "number") continue;
    const value = form[field];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    // A mailing address is one line of comma-separated parts, and a city
    // or street alone still identifies the person.
    const parts =
      kind === "addresses"
        ? text.split(",").map((part) => part.trim()).filter((part) => part.length >= 3)
        : [];
    found[kind] = [...(found[kind] ?? []), text, ...parts];
  }
  return found;
}

// A personal field becomes its label, or stays empty so a missing value
// still shows. A number field stays a number only when it is a plain one
// no longer than an income; anything else is scrubbed text, so a phone
// number typed into it is still caught.
function formValue(
  value: unknown,
  kind: EntityKind | "number",
  scrub: (text: string) => string,
): unknown {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (kind !== "number") {
    return String(value).trim() === "" ? "" : KNOWN_LABELS[kind];
  }
  const text = String(value).trim();
  return PLAIN_NUMBER.test(text) ? Number(text) : scrub(text);
}

// Build the request that leaves Mano for the guardian model, explicitly from
// the validated schema fields the checker needs. Unknown fields anywhere on
// the input are dropped, never copied. Every string that remains is
// scrubbed: the recipient becomes [RECIPIENT] everywhere it appears, other
// consented destinations become [OTHER-1], [OTHER-2] and so on, and emails,
// phones and links in free text get numbered labels, so the model can still
// compare destinations without seeing their values. Labels match by exact
// canonical value, so case-distinct paths stay distinct. Everything else
// structural goes through redact(). A submit also carries its form fields
// (SUBMIT_FORM_FIELDS) and says when a document is attached. Only the
// action type, source kinds, the origin and form numbers pass through
// untouched.
export function buildModelRequest(
  input: CheckInput,
  known?: KnownEntities,
): ModelRequest {
  const raw = input.action.payload;
  const form =
    input.action.type === "submit" &&
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const entities = form === null ? known : mergeEntities(known, formEntities(form));
  const labels = new DestinationLabels();
  const recipient = canonicalRecipient(input.action.recipient);
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
    input.action.recipient,
    ...input.consents.map((consent) => consent.recipient),
  ].sort((a, b) => b.length - a.length);
  const scrub = (text: string): string => {
    let out = text;
    for (const destination of destinations) {
      out = replaceDestination(out, destination, otherLabel(destination));
    }
    out = labels.labelAll(out);
    return redact(out, entities);
  };
  const scrubStrings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").map(scrub)
      : [];
  const scrubString = (value: unknown): string | undefined =>
    typeof value === "string" ? scrub(value) : undefined;

  const payload: Record<string, unknown> = {};
  if (typeof raw === "string") {
    payload["text"] = scrub(raw);
  } else if (Array.isArray(raw)) {
    payload["claims"] = scrubStrings(raw);
  } else if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const schema = PAYLOAD_SCHEMAS[input.action.type] ?? {
      destinations: [],
      content: [],
      extra: [],
    };
    if (record["claims"] !== undefined) {
      payload["claims"] = scrubStrings(record["claims"]);
    }
    for (const field of [
      ...schema.destinations,
      ...schema.content,
      ...schema.extra,
    ]) {
      const scrubbed = scrubString(record[field]);
      if (scrubbed !== undefined) {
        payload[field] = scrubbed;
      }
    }
  }
  if (form !== null) {
    for (const [field, kind] of Object.entries(SUBMIT_FORM_FIELDS)) {
      const value = formValue(form[field], kind, scrub);
      if (value !== undefined) payload[field] = value;
    }
  }
  if (input.action.type === "submit" && input.action.documentHash !== null) {
    payload["attachment"] = "[DOCUMENT]";
  }

  return {
    action: {
      type: input.action.type,
      recipient: scrub(input.action.recipient),
      purpose: scrub(input.action.purpose),
      payload,
    },
    sources: input.sources.map((source) => ({
      kind: source.kind,
      id: scrub(source.id),
      ...(source.quote === undefined ? {} : { quote: scrub(source.quote) }),
    })),
    consents: input.consents.map((consent) => ({
      recipient: scrub(consent.recipient),
      purpose: scrub(consent.purpose),
    })),
    origin: input.origin,
  };
}
