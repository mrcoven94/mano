// Sign-in codes and web session tokens. Both use keys derived from the
// handle grant secret, each under its own label, so nothing signed for
// one purpose verifies as another and the web adds no secret of its own.
//
// No code is stored: it is an HMAC of the challenge ID and the address.
// Whoever holds the grant secret can already act for any person, so
// being able to compute a code gives them nothing new.

export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_SECONDS = 24 * 3600;

const B64_PLUS = /\+/g;
const B64_SLASH = /\//g;
const B64_PADDING = /=+$/;
const B64URL_DASH = /-/g;
const B64URL_UNDERSCORE = /_/g;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const encoder = new TextEncoder();

async function hmac(key: BufferSource, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}

async function derive(secret: string, label: string): Promise<Uint8Array> {
  return hmac(encoder.encode(secret), `mano-web:${label}:v1`);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(B64_PLUS, "-").replace(B64_SLASH, "_").replace(B64_PADDING, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(B64URL_DASH, "+").replace(B64URL_UNDERSCORE, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return null;
  return email;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function signInCode(secret: string, challengeId: string, email: string): Promise<string> {
  const mac = await hmac(await derive(secret, "code"), `${challengeId}:${email}`);
  const n = new DataView(mac.buffer, mac.byteOffset).getUint32(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

export function codesMatch(a: string, b: string): boolean {
  return sameBytes(encoder.encode(a), encoder.encode(b));
}

export interface WebClaims {
  sub: string;
  iat: number;
  exp: number;
}

export async function mintWebSession(secret: string, personId: string, nowMs: number): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload = b64url(encoder.encode(JSON.stringify({ sub: personId, iat, exp } satisfies WebClaims)));
  const mac = await hmac(await derive(secret, "session"), `w1.${payload}`);
  return { token: `w1.${payload}.${b64url(mac)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyWebSession(secret: string, token: string, nowMs: number): Promise<WebClaims | null> {
  try {
    const [version, payload, mac, ...rest] = token.split(".");
    if (version !== "w1" || !payload || !mac || rest.length > 0) return null;
    const expected = await hmac(await derive(secret, "session"), `w1.${payload}`);
    if (!sameBytes(expected, fromB64url(mac))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as WebClaims;
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function addressHash(secret: string, email: string): Promise<string> {
  return hex(await hmac(await derive(secret, "address"), email));
}
