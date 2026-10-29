// Typed, immutable view of a frozen approval request. The engine binds
// the approval to requestJson and executes it verbatim, so the screen
// shows every field the executor will use: type, recipient, purpose,
// idempotency key, document and each payload entry. Anything that does
// not match a known action shape comes back unknown, and the screen
// refuses to approve it.

export interface ActionRow {
  label: string;
  value: string;
}

export type ParsedAction =
  | { kind: "submit" | "send" | "share" | "call" | "fax"; rows: ActionRow[] }
  | { kind: "unknown"; reason: string };

const ACTION_TYPES = new Set(["send", "submit", "call", "fax", "share"]);

type KnownKind = "submit" | "send" | "share" | "call" | "fax";

const LABELS: Record<string, string> = {
  text: "Message",
  body: "Message",
  message: "Message",
  to: "To",
  consent: "Consent",
  caseId: "Case",
  scope: "Scope",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Full values, never truncated: the approval covers the whole request
// hash, so the screen shows the whole value and scrolls to fit it.
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  try {
    return JSON.stringify(value) ?? "[unreadable]";
  } catch {
    return "[unreadable]";
  }
}

function labelFor(key: string): string {
  // hasOwnProperty, not lookup: LABELS["__proto__"] is the prototype.
  if (Object.prototype.hasOwnProperty.call(LABELS, key)) return LABELS[key] as string;
  return key;
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
  const rows: ActionRow[] = [
    { label: "To", value: formatValue(raw.recipient) },
    { label: "Why", value: formatValue(raw.purpose) },
    { label: "Reference", value: formatValue(raw.idempotencyKey) },
  ];
  if (typeof raw.documentId === "string" && raw.documentId) {
    rows.push({ label: "Document", value: raw.documentId });
  }
  for (const key of Object.keys(raw.payload)) {
    rows.push({ label: labelFor(key), value: formatValue(raw.payload[key]) });
  }
  return { kind, rows };
}
