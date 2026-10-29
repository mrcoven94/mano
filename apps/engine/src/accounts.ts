// Engine accounts: the engine side of the site's accounts contract.
//
// The site (packages/accounts HttpEngineAccounts) calls here to route a
// verified text handle to a person, exchange a WorkOS user for an engine
// session, read one thread everywhere, and move case data on merge. The
// PersonAgent stays the system of record: identities, thread, counts and
// the sign-in activity log live in its own SQLite. The AccountsRegistry
// Durable Object holds only the routing index (handle hash to person,
// WorkOS user to person) so one handle is claimed by exactly one person.
//
// Every route in this module takes the server-to-server service key as a
// Bearer [REDACTED] The person-scoped reads (thread, counts, activity) also accept
// a person session token, but only when its verified subject matches the
// route. Worker and agents share the helpers here so both sides
// normalize, hash, validate and scrub exactly the same way.
import { decryptForPerson, encryptForPerson, type EncryptedBlob } from "./crypto.js";
import { base64ToBytes } from "./hash.js";

// The registry is a singleton: worker and agents open it by this name.
export const ACCOUNTS_REGISTRY_NAME = "mano-accounts-registry-v1";

export type ThreadChannel = "text" | "web" | "app";

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel: ThreadChannel;
  createdAt: string;
}

export interface DataCounts {
  conversationMessages: number;
  documents: number;
  approvals: number;
  consents: number;
}

export interface ActivityEntry {
  at: string;
  event: string;
  detail: Record<string, unknown>;
}

export interface ServiceEnv {
  MANO_ENGINE_SERVICE_KEY?: string;
  MANO_ENV?: string;
}

// Dev-only fallback. It exists only when MANO_ENV=development is set
// explicitly; anywhere else a missing service key leaves accounts
// unconfigured and every accounts route returns 503. The value is
// published in this public repo, so it must never guard real accounts.
export const DEV_SERVICE_KEY = "mano-dev-service-key-NOT-FOR-PROD";
let warnedDevServiceKey = false;

export function getServiceKey(env: ServiceEnv): { key: string; dev: boolean } | null {
  if (env.MANO_ENGINE_SERVICE_KEY) return { key: env.MANO_ENGINE_SERVICE_KEY, dev: false };
  if (env.MANO_ENV !== "development") return null;
  if (!warnedDevServiceKey) {
    warnedDevServiceKey = true;
    console.warn(
      "[mano] MANO_ENGINE_SERVICE_KEY is not set; accounts routes accept a dev-only key. " +
        "Set MANO_ENGINE_SERVICE_KEY before any real use.",
    );
  }
  return { key: DEV_SERVICE_KEY, dev: true };
}

export type IdentityHandle = "phone" | "email" | "workos";

export interface NormalizedIdentity {
  handle: IdentityHandle;
  value: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKOS_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

// Canonicalizes a verified handle so the same person always hashes the
// same way: emails lowercase, phones to E.164 digits. Throws a plain
// Error without echoing the value; the worker answers 400.
export function normalizeIdentity(handle: string, value: string): NormalizedIdentity {
  if (handle !== "phone" && handle !== "email" && handle !== "workos") {
    throw new Error("Handle must be phone, email or workos.");
  }
  if (typeof value !== "string") throw new Error("Handle value must be a string.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320) throw new Error("Handle value must be 1 to 320 characters.");
  if (handle === "email") {
    const lower = trimmed.toLowerCase();
    if (!EMAIL_PATTERN.test(lower)) throw new Error("Email address is invalid.");
    return { handle, value: lower };
  }
  if (handle === "workos") {
    if (!WORKOS_ID_PATTERN.test(trimmed)) throw new Error("WorkOS user ID is invalid.");
    return { handle, value: trimmed };
  }
  const digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+") || digits.length < 7 || digits.length > 15) {
    throw new Error("Phone number must be E.164 with 7 to 15 digits.");
  }
  return { handle, value: `+${digits}` };
}

async function hmacKeyFromKek(kekB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(kekB64);
  } catch {
    throw new Error("ENCRYPTION_KEK_B64 is not valid base64.");
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

// Keyed lookup hash for an identity. The registry and the agent store
// this, never the raw handle, as the lookup key.
export async function identityHash(kekB64: string, handle: IdentityHandle, value: string): Promise<string> {
  if (!kekB64) throw new Error("ENCRYPTION_KEK_B64 is not set; accounts are unavailable.");
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKeyFromKek(kekB64),
    new TextEncoder().encode(`mano-identity:v1:${handle}:${value}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function identityAad(personId: string, handleHash: string): Uint8Array {
  return new TextEncoder().encode(`mano-identity:v1:${personId}:${handleHash}`);
}

// The encrypted identity value stored in the agent. Bound to one
// person's one handle hash, so it decrypts nowhere else.
export async function encryptIdentityValue(
  value: string,
  kekB64: string,
  personId: string,
  handleHash: string,
): Promise<string> {
  if (!kekB64) throw new Error("ENCRYPTION_KEK_B64 is not set; accounts are unavailable.");
  const blob = await encryptForPerson(
    new TextEncoder().encode(value),
    kekB64,
    identityAad(personId, handleHash),
  );
  return JSON.stringify(blob);
}

export async function decryptIdentityValue(
  stored: string,
  kekB64: string,
  personId: string,
  handleHash: string,
): Promise<string> {
  if (!kekB64) throw new Error("ENCRYPTION_KEK_B64 is not set; accounts are unavailable.");
  const bytes = await decryptForPerson(
    JSON.parse(stored) as EncryptedBlob,
    kekB64,
    identityAad(personId, handleHash),
  );
  return new TextDecoder().decode(bytes);
}

// Keys that must never appear in a stored audit detail, matched per
// word so "postcode" passes while "auth_code" and "passcode" fail.
const BANNED_DETAIL_KEY = /(^|[^a-z])(code|otp|pin|passcode|pincode|password|secret|ssn|cvv|backupcode)($|[^a-z])/i;
const DIGIT_RUN = /\d{6,}/;
const BARE_SHORT_CODE = /^\d{4,8}$/;
const ENTIRELY_PHONE_CHARS = /^\+?[\d\s().-]{7,24}$/;
const EVENT_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_DETAIL_JSON = 4096;

function detailValueForbidden(value: unknown, depth: number): boolean {
  if (depth > 10) return true;
  if (typeof value === "string") {
    if (DIGIT_RUN.test(value) || BARE_SHORT_CODE.test(value)) return true;
    if (ENTIRELY_PHONE_CHARS.test(value) && (value.replace(/\D/g, "").length >= 7)) return true;
    return false;
  }
  if (typeof value === "number") {
    // A 6 to 8 digit integer is shaped like a code. Counts, years and
    // epoch timestamps (10 or 13 digits) pass.
    return Number.isInteger(value) && value >= 100000 && value <= 99999999;
  }
  if (Array.isArray(value)) return value.some((v) => detailValueForbidden(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => BANNED_DETAIL_KEY.test(k) || detailValueForbidden(v, depth + 1),
    );
  }
  return false;
}

// Rejects sign-in audit detail that carries a code or a full number,
// before anything is stored. Throws without echoing the detail; the
// worker answers 400. Both worker (fast 400) and agent (system of
// record) enforce this.
export function scrubAuditDetail(event: string, detail: unknown): { event: string; detailJson: string } {
  if (typeof event !== "string" || !EVENT_PATTERN.test(event)) {
    throw new Error("Audit event must be 1 to 80 letters, digits, dots, dashes or underscores.");
  }
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("Audit detail must be an object.");
  }
  let detailJson: string;
  try {
    detailJson = JSON.stringify(detail);
  } catch {
    throw new Error("Audit detail must be JSON.");
  }
  if (detailJson.length > MAX_DETAIL_JSON) throw new Error("Audit detail is too large.");
  if (detailValueForbidden(detail, 0)) {
    throw new Error("Audit detail must not contain codes or full numbers.");
  }
  return { event, detailJson };
}

export interface ThreadInput {
  role: "user" | "assistant";
  content: string;
  channel: ThreadChannel;
}

// Validates a thread append. Throws a plain Error; the worker answers.
export function validateThreadInput(input: unknown): ThreadInput {
  const body = (input ?? {}) as { role?: unknown; content?: unknown; channel?: unknown };
  if (body.role !== "user" && body.role !== "assistant") {
    throw new Error("Thread role must be user or assistant.");
  }
  if (typeof body.content !== "string" || body.content.length === 0 || body.content.length > 20000) {
    throw new Error("Thread content must be 1 to 20000 characters.");
  }
  if (body.channel !== "text" && body.channel !== "web" && body.channel !== "app") {
    throw new Error("Thread channel must be text, web or app.");
  }
  return { role: body.role, content: body.content, channel: body.channel };
}

export function validatePersonId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("Person ID must be 1 to 200 characters.");
  }
  return value;
}
