// Session tokens: the only identity the engine trusts.
//
// A token is `v1.<base64url claims>.<base64url HMAC-SHA256>`. Person routes
// accept person tokens whose subject matches the route; org routes accept
// staff tokens carrying the matching org ID. Caller-supplied names
// (`x-person-id`, bare bearer names) are never identity.

export type SessionKind = "person" | "staff";

export interface SessionClaims {
  kind: SessionKind;
  sub: string;
  org: string | null;
  iat: number;
  exp: number;
}

export interface SessionMintInput {
  kind: SessionKind;
  sub: string;
  org?: string;
}

// Dev-only fallback. Real deployments set SESSION_SECRET; nothing secret is
// protected by this value and the warning below says so on every cold start.
const DEV_SESSION_SECRET = "mano-dev-session-secret-NOT-FOR-PROD";
let warnedDevSecret = false;

export function getSessionSecret(env: { SESSION_SECRET?: string }): { secret: string; dev: boolean } {
  if (env.SESSION_SECRET) return { secret: env.SESSION_SECRET, dev: false };
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn(
      "[mano] SESSION_SECRET is not set; signing sessions with a dev-only secret. " +
        "Set SESSION_SECRET before any real use.",
    );
  }
  return { secret: DEV_SESSION_SECRET, dev: true };
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintSessionToken(
  input: SessionMintInput,
  secret: string,
  ttlSeconds = 24 * 3600,
  nowMs = Date.now(),
): Promise<string> {
  if (!input.sub || typeof input.sub !== "string") throw new Error("Session subject must be a non-empty string.");
  if (input.kind !== "person" && input.kind !== "staff") throw new Error("Session kind must be person or staff.");
  if (input.kind === "staff" && !input.org) throw new Error("Staff sessions must carry an org ID.");
  const claims: SessionClaims = {
    kind: input.kind,
    sub: input.sub,
    org: input.org ?? null,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
  };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`v1.${payload}`),
  );
  return `v1.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<SessionClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(parts[2]) as BufferSource,
      new TextEncoder().encode(`v1.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as SessionClaims;
    if (claims.kind !== "person" && claims.kind !== "staff") return null;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (claims.kind === "staff" && (typeof claims.org !== "string" || !claims.org)) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) return null;
    if (typeof claims.iat !== "number" || claims.iat * 1000 > now.getTime() + 60_000) return null;
    return { kind: claims.kind, sub: claims.sub, org: claims.org ?? null, iat: claims.iat, exp: claims.exp };
  } catch {
    return null;
  }
}

// Returns the verified claims for a Bearer session token, or null when the
// request carries no usable credential.
export async function authenticate(
  request: Request,
  env: { SESSION_SECRET?: string },
): Promise<SessionClaims | null> {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return authenticateToken(auth.slice("Bearer ".length).trim(), env);
}

// Verifies a bare token string. Used for the Authorization header and for
// the ?token= query param on the WebSocket route, where browsers cannot
// set headers.
export async function authenticateToken(
  token: string,
  env: { SESSION_SECRET?: string },
): Promise<SessionClaims | null> {
  if (!token) return null;
  const { secret } = getSessionSecret(env);
  return verifySessionToken(token, secret);
}
