import { base64ToBytes } from "../hash.js";
import { readClientState } from "./fax.js";

// What the mail and fax providers report after a send. A receipt means the
// provider took it; these say what became of it. Both providers sign their
// webhooks over the raw body, and an unsigned, wrongly signed or old
// request changes nothing.
export interface DeliveryEvent {
  personId: string;
  channel: "fax" | "mail";
  externalId: string;
  status: string;
  eventId: string;
}

// The sender's own five-minute replay window.
const TOLERANCE_MS = 5 * 60_000;

function fresh(timestampMs: number, nowMs: number): boolean {
  return Number.isFinite(timestampMs) && Math.abs(nowMs - timestampMs) <= TOLERANCE_MS;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
}

// Lob-Signature is the hex HMAC-SHA256 of "<timestamp>.<body>" under the
// webhook's own secret. crypto.subtle.verify compares in constant time.
export async function verifyMailSignature(rawBody: string, headers: Headers, secret: string, nowMs = Date.now()): Promise<boolean> {
  const signature = hexToBytes(headers.get("lob-signature") ?? "");
  const timestamp = headers.get("lob-signature-timestamp") ?? "";
  if (!signature || !timestamp || !fresh(Date.parse(timestamp), nowMs)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${timestamp}.${rawBody}`));
}

// telnyx-signature-ed25519 is the base64 Ed25519 signature of
// "<timestamp>|<body>", with the timestamp in seconds.
export async function verifyFaxSignature(rawBody: string, headers: Headers, publicKeyB64: string, nowMs = Date.now()): Promise<boolean> {
  const signature = headers.get("telnyx-signature-ed25519") ?? "";
  const timestamp = headers.get("telnyx-timestamp") ?? "";
  if (!signature || !/^\d+$/.test(timestamp) || !fresh(Number(timestamp) * 1000, nowMs)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", base64ToBytes(publicKeyB64).slice(), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, base64ToBytes(signature).slice(), new TextEncoder().encode(`${timestamp}|${rawBody}`));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Null for anything that is not one of our own letters.
export function parseMailEvent(rawBody: string): DeliveryEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(event) || !isRecord(event.body) || !isRecord(event.event_type) || !isRecord(event.body.metadata)) return null;
  const { id: externalId, metadata } = event.body;
  const { id: eventId } = event;
  const { id: status } = event.event_type;
  const personId = metadata.mano_person;
  if (typeof personId !== "string" || !personId) return null;
  if (typeof externalId !== "string" || typeof eventId !== "string" || typeof status !== "string") return null;
  return { personId, channel: "mail", externalId, status, eventId };
}

// Null for anything that is not one of our own faxes.
export function parseFaxEvent(rawBody: string): DeliveryEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(event) || !isRecord(event.data) || !isRecord(event.data.payload)) return null;
  const { id: eventId, event_type: status, payload } = event.data;
  const { fax_id: externalId, client_state: clientState } = payload as Record<string, unknown>;
  const state = readClientState(clientState);
  if (!state || typeof externalId !== "string" || typeof eventId !== "string" || typeof status !== "string") return null;
  return { personId: state.personId, channel: "fax", externalId, status, eventId };
}

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): unknown;
}

export function ensureDeliveryTable(sql: SqlLike): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS delivery_events(event_id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL)`);
}

// Providers retry webhooks, so the same event records once.
export function recordDeliveryEvent(sql: SqlLike, event: DeliveryEvent, now: Date): void {
  sql.exec(
    `INSERT OR IGNORE INTO delivery_events(event_id, channel, external_id, status, received_at) VALUES (?, ?, ?, ?, ?)`,
    event.eventId,
    event.channel,
    event.externalId,
    event.status,
    now.toISOString(),
  );
}
