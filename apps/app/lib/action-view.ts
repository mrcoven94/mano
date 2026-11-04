// Typed, immutable view of a frozen approval request. The engine binds
// the approval to requestJson and executes it verbatim, so the screen
// shows every field the executor will use: type, recipient, purpose,
// idempotency key, document and each payload entry. Payload entries
// come back in the request's order with a string key for known names
// (lib/strings.ts) and the raw name otherwise, so nothing is dropped.
// Anything that does not match a known action shape comes back unknown,
// and the screen refuses to approve it. An unknown action's reason is for
// tests and logs; the screen shows its own line in the person's language.

import type { StringKey } from "./strings";

export type KnownKind = "submit" | "send" | "share" | "call" | "fax" | "mail";

// How the screen writes a value. Only the label and the number format
// change; the words and digits are the request's own. A true or false, a
// null and a value with no text form have no words of their own, so the
// screen supplies them in the person's language.
export type FieldFormat = "text" | "money" | "date" | "consent" | "flag" | "empty" | "unreadable";

export interface ActionField {
  key: string;
  // A friendly label in the person's language, or null to show key.
  label: StringKey | null;
  value: string;
  format: FieldFormat;
}

export interface KnownAction {
  kind: KnownKind;
  recipient: string;
  purpose: string;
  reference: string;
  documentId: string | null;
  // What the person states, in request order. Declaration and
  // attachment are lifted out because the screen shows them on their own.
  answers: ActionField[];
  declaration: string | null;
  attachment: string | null;
}

export type ParsedAction = KnownAction | { kind: "unknown"; reason: string };

const ACTION_TYPES = new Set(["send", "submit", "call", "fax", "mail", "share"]);

// Payload names the agent and engine write today (apps/agent forms.ts,
// pending.ts and the engine's share requests), mapped to labels.
const LABELS: Record<string, { label: StringKey; format?: FieldFormat }> = {
  caseNumber: { label: "fieldCase" },
  caseId: { label: "fieldCase" },
  fullName: { label: "fieldName" },
  dateOfBirth: { label: "fieldBirth", format: "date" },
  householdSize: { label: "fieldHousehold" },
  monthlyIncome: { label: "fieldIncome", format: "money" },
  address: { label: "fieldAddress" },
  phone: { label: "fieldPhone" },
  office: { label: "fieldOffice" },
  text: { label: "fieldMessage" },
  body: { label: "fieldMessage" },
  message: { label: "fieldMessage" },
  to: { label: "fieldTo" },
  consent: { label: "fieldConsent", format: "consent" },
  scope: { label: "fieldScope" },
};

const DECLARATION = "declaration";
const ATTACHMENT = "attachment";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Full values, never truncated: the approval covers the whole request
// hash, so the screen shows the whole value and scrolls to fit it.
function formatValue(value: unknown): { text: string; format?: FieldFormat } {
  if (typeof value === "string") return { text: value };
  if (typeof value === "number") return { text: String(value) };
  if (typeof value === "boolean") return { text: String(value), format: "flag" };
  if (value == null) return { text: "", format: "empty" };
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return { text: value.join(", ") };
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined ? { text: "", format: "unreadable" } : { text: json };
  } catch {
    return { text: "", format: "unreadable" };
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN_AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;

// YYYY-MM-DD naming a day that exists, in a year from 1900 to this one,
// so 1988-02-30 stays as written, and so does 0000-01-01, which would
// otherwise read the same as 0001-01-01.
function isCalendarDay(text: string): boolean {
  if (!ISO_DAY.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return false;
  const year = date.getUTCFullYear();
  return year >= 1900 && year <= new Date().getUTCFullYear();
}

function fieldFor(key: string, value: unknown): ActionField {
  // hasOwnProperty, not lookup: LABELS["__proto__"] is the prototype.
  const known = Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : undefined;
  const { text, format: shape } = formatValue(value);
  if (shape) return { key, label: known?.label ?? null, value: text, format: shape };
  const format = known?.format ?? "text";
  // A money label only fits a plain amount and a date label only a real
  // calendar day; anything else shows as text.
  const fits =
    format === "money"
      ? PLAIN_AMOUNT.test(text)
      : format === "date"
        ? isCalendarDay(text)
        : true;
  return { key, label: known?.label ?? null, value: text, format: fits ? format : "text" };
}

export function parseActionView(requestJson: string): ParsedAction {
  let raw: unknown;
  try {
    raw = JSON.parse(requestJson) as unknown;
  } catch {
    return { kind: "unknown", reason: "The frozen request is not readable." };
  }
  if (!isRecord(raw)) return { kind: "unknown", reason: "The frozen request is not an object." };
  if (typeof raw.type !== "string" || !ACTION_TYPES.has(raw.type)) {
    return { kind: "unknown", reason: "Unknown action type." };
  }
  if (typeof raw.recipient !== "string" || !raw.recipient) {
    return { kind: "unknown", reason: "The request names no recipient." };
  }
  if (typeof raw.purpose !== "string" || !raw.purpose) {
    return { kind: "unknown", reason: "The request states no purpose." };
  }
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) {
    return { kind: "unknown", reason: "The request carries no reference." };
  }
  if (!isRecord(raw.payload)) return { kind: "unknown", reason: "The request payload is not an object." };
  const kind = raw.type as KnownKind;
  if (kind === "share") {
    if (raw.payload.consent !== "grant" && raw.payload.consent !== "revoke") {
      return { kind: "unknown", reason: "A share must declare a grant or a revoke." };
    }
    if (typeof raw.payload.caseId !== "string" || !raw.payload.caseId) {
      return { kind: "unknown", reason: "A share must name a case." };
    }
  }
  const answers: ActionField[] = [];
  let declaration: string | null = null;
  let attachment: string | null = null;
  for (const key of Object.keys(raw.payload)) {
    const value = raw.payload[key];
    // Lifted out only as plain text; any other shape stays a row.
    if (key === DECLARATION && typeof value === "string" && value) declaration = value;
    else if (key === ATTACHMENT && typeof value === "string" && value) attachment = value;
    else answers.push(fieldFor(key, value));
  }
  // The payload holds the document's ID for the safety check, and the words the
  // person reads are the request's own. A draft frozen before that holds its
  // words in the payload.
  if (typeof raw.attachmentLabel === "string" && raw.attachmentLabel) attachment = raw.attachmentLabel;
  else if (attachment === raw.documentId) attachment = null;
  return {
    kind,
    recipient: raw.recipient,
    purpose: raw.purpose,
    reference: raw.idempotencyKey,
    documentId: typeof raw.documentId === "string" && raw.documentId ? raw.documentId : null,
    answers,
    declaration,
    attachment,
  };
}
