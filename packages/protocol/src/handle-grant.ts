// Handle grants: Channels' signed statement that it just verified an
// inbound message from one handle. The agent forwards the grant to the
// engine with its own service token; the engine then lets the agent act
// for that handle's person only, and only until the grant expires.
//
// Format: `hg1.<base64url claims>.<base64url HMAC-SHA256>`, signed with
// MANO_HANDLE_GRANT_SECRET, which Channels and the engine hold and the
// agent never does. The MAC covers a domain prefix, so a grant can never
// verify as another kind of token signed with the same secret.

export interface HandleGrantClaims {
  v: 1;
  // Channels' peppered handle hash: 64 lowercase hex characters.
  handle: string;
  iat: number;
  exp: number;
}

export const HANDLE_GRANT_MAX_TTL_SECONDS = 900;
const HANDLE_HASH = /^[0-9a-f]{64}$/;
const MAC_PREFIX = "mano-handle-grant:v1.";

// The engine person a handle maps to. The agent builds route paths with
// it; the engine accepts a grant only on this person's routes.
export function personIdForHandle(handleHash: string): string {
  if (!HANDLE_HASH.test(handleHash)) throw new Error("Handle hash must be 64 lowercase hex characters.");
  return `handle-${handleHash}`;
}

// The handle hash behind a handle person, or null for any other person.
export function handleForPersonId(personId: string): string | null {
  const match = /^handle-([0-9a-f]{64})$/.exec(personId);
  return match ? match[1] : null;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function macKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function mintHandleGrant(
  handleHash: string,
  secret: string,
  ttlSeconds = 600,
  nowMs = Date.now(),
): Promise<string> {
  if (!HANDLE_HASH.test(handleHash)) throw new Error("Handle hash must be 64 lowercase hex characters.");
  if (!secret) throw new Error("Handle grants need a secret.");
  if (!(ttlSeconds > 0 && ttlSeconds <= HANDLE_GRANT_MAX_TTL_SECONDS)) {
    throw new Error(`Handle grant lifetime must be 1 to ${HANDLE_GRANT_MAX_TTL_SECONDS} seconds.`);
  }
  const iat = Math.floor(nowMs / 1000);
  const claims: HandleGrantClaims = { v: 1, handle: handleHash, iat, exp: iat + ttlSeconds };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign("HMAC", await macKey(secret), new TextEncoder().encode(MAC_PREFIX + payload));
  return `hg1.${payload}.${b64urlEncode(new Uint8Array(mac))}`;
}

// The verified claims, or null for anything forged, expired, from the
// future, or living longer than the maximum lifetime.
export async function verifyHandleGrant(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<HandleGrantClaims | null> {
  try {
    if (!secret) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "hg1" || !parts[1] || !parts[2]) return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await macKey(secret),
      b64urlDecode(parts[2]) as BufferSource,
      new TextEncoder().encode(MAC_PREFIX + parts[1]),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as HandleGrantClaims;
    if (claims.v !== 1 || typeof claims.handle !== "string" || !HANDLE_HASH.test(claims.handle)) return null;
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= nowMs) return null;
    if (claims.iat * 1000 > nowMs + 60_000) return null;
    if (claims.exp - claims.iat > HANDLE_GRANT_MAX_TTL_SECONDS) return null;
    return { v: 1, handle: claims.handle, iat: claims.iat, exp: claims.exp };
  } catch {
    return null;
  }
}
