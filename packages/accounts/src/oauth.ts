// OAuth login guard: server-generated state bound to the browser, the
// session, and the linking intent, plus PKCE (S256). Follows the WorkOS
// AuthKit guidance: random state, PKCE code challenge on the authorize
// URL, verifier on the code exchange, short-lived pending login.
//
// The site keeps no server state (serverless). issueChallenge returns a
// signed, encrypted-then-MACed cookie value holding the state secret, the
// PKCE verifier, the session binding, and the intent. The callback hands
// the cookie back with the returned state; consumeChallenge verifies all
// of it in one step. Never log the state, verifier, or session binding.

import { keyedHash } from "./crypto";

export const OAUTH_STATE_COOKIE = "mano-oauth";
export const OAUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface OAuthIssueInput {
  // Null when the browser has no session (plain sign-in).
  sessionToken: string | null;
  pepper: string;
  now?: () => number;
}

export interface OAuthChallenge {
  // Random state to send to WorkOS. The cookie holds its hash only.
  state: string;
  // S256 challenge to send to WorkOS. The cookie holds the verifier.
  codeChallenge: string;
  // Cookie value: base64url(payload).base64url(sig).
  cookieValue: string;
}

export interface OAuthConsumeInput {
  cookieValue: string | null;
  returnedState: string | null;
  // Current session at callback time. Must match the session bound at issue.
  sessionToken: string | null;
  pepper: string;
  now?: () => number;
}

export interface OAuthConsumed {
  codeVerifier: string;
  // True when the login started from a signed-in session (link, not sign-in).
  linking: boolean;
}

function b64urlEncode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64url"));
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomB64url(bytes: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256B64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64urlEncode(new Uint8Array(digest));
}

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueOAuthChallenge(input: OAuthIssueInput): Promise<OAuthChallenge> {
  const now = input.now ?? Date.now;
  const state = randomB64url(32);
  const codeVerifier = randomB64url(32);
  const codeChallenge = await sha256B64url(codeVerifier);
  const sessionBinding = input.sessionToken
    ? await keyedHash(input.sessionToken, input.pepper, "mano-oauth:session:v1")
    : null;
  const payload = {
    v: 1,
    stateHash: await keyedHash(state, input.pepper, "mano-oauth:state:v1"),
    verifier: codeVerifier,
    session: sessionBinding,
    linking: input.sessionToken !== null,
    exp: now() + OAUTH_CHALLENGE_TTL_MS,
  };
  const encoded = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await keyedHash(encoded, input.pepper, "mano-oauth:cookie:v1");
  return { state, codeChallenge, cookieValue: `${encoded}.${b64urlEncode(new TextEncoder().encode(sig))}` };
}

export async function consumeOAuthChallenge(input: OAuthConsumeInput): Promise<OAuthConsumed> {
  const now = input.now ?? Date.now;
  const fail = () => {
    throw new Error("Sign-in attempt expired. Start again.");
  };
  if (!input.cookieValue || !input.returnedState) fail();
  const parts = (input.cookieValue as string).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail();
  const expectedSig = await keyedHash(parts[0], input.pepper, "mano-oauth:cookie:v1");
  const givenSig = new TextDecoder().decode(b64urlDecode(parts[1]));
  if (!secretsEqual(givenSig, expectedSig)) fail();
  let payload: { v: number; stateHash: string; verifier: string; session: string | null; linking: boolean; exp: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  } catch {
    fail();
    throw new Error("unreachable");
  }
  if (payload.v !== 1 || typeof payload.exp !== "number" || payload.exp <= now()) fail();
  if (typeof payload.verifier !== "string" || !payload.verifier) fail();
  const stateHash = await keyedHash(input.returnedState as string, input.pepper, "mano-oauth:state:v1");
  if (!secretsEqual(stateHash, payload.stateHash)) fail();
  // Bound to the session (or the anonymous state) the login started from.
  const currentBinding = input.sessionToken
    ? await keyedHash(input.sessionToken, input.pepper, "mano-oauth:session:v1")
    : null;
  if (payload.session === null || currentBinding === null) {
    if (payload.session !== currentBinding) fail();
  } else if (!secretsEqual(currentBinding, payload.session)) {
    fail();
  }
  if (payload.linking !== (input.sessionToken !== null)) fail();
  return { codeVerifier: payload.verifier, linking: payload.linking };
}

// Origin check for the OAuth start route. The request must come from the
// site itself: an Origin (or Referer fallback) whose origin matches the
// site origin. Missing both fails closed.
export function originAllowed(requestUrl: string, origin: string | null, referer: string | null): boolean {
  try {
    const site = new URL(requestUrl).origin;
    if (origin) return new URL(origin).origin === site;
    if (referer) return new URL(referer).origin === site;
    return false;
  } catch {
    return false;
  }
}
