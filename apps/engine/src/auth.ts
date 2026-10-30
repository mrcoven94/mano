// Session tokens and the agent's service credential (at the end of this
// file): the only identities the engine trusts.
//
// A token is `v1.<base64url claims>.<base64url HMAC-SHA256>`. Person routes
// accept person tokens whose subject matches the route; org routes accept
// staff tokens carrying the matching org ID. Caller-supplied names
// (`x-person-id`, bare bearer names) are never identity.

import { personIdForHandle, verifyHandleGrant } from "@mano/protocol";
import { timingSafeEqual } from "./hash.js";

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

// Dev-only fallback. It exists only when MANO_ENV=development is set
// explicitly; anywhere else a missing SESSION_SECRET leaves sessions
// unconfigured and every authenticated route returns 503. The value is
// published in this public repo, so it must never sign real sessions.
const DEV_SESSION_SECRET = "mano-dev-session-secret-NOT-FOR-PROD";
let warnedDevSecret = false;

export interface SessionEnv {
  SESSION_SECRET?: string;
  MANO_ENV?: string;
}

export function getSessionSecret(env: SessionEnv): { secret: string; dev: boolean } | null {
  if (env.SESSION_SECRET) return { secret: env.SESSION_SECRET, dev: false };
  if (env.MANO_ENV !== "development") return null;
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn(
      "[mano] SESSION_SECRET is not set; signing sessions with a dev-only secret. " +
        "Set SESSION_SECRET before any real use.",
    );
  }
  return { secret: DEV_SESSION_SECRET, dev: true };
}

// False when no session can be minted or verified. The worker answers 503
// on authenticated routes in that state instead of failing open.
export function sessionConfigured(env: SessionEnv): boolean {
  return getSessionSecret(env) !== null;
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
  env: SessionEnv,
): Promise<SessionClaims | null> {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return authenticateToken(auth.slice("Bearer ".length).trim(), env);
}

// Verifies a bare token string from the Authorization header.
export async function authenticateToken(
  token: string,
  env: SessionEnv,
): Promise<SessionClaims | null> {
  if (!token) return null;
  const configured = getSessionSecret(env);
  if (!configured) return null;
  return verifySessionToken(token, configured.secret);
}

export interface WsTicketClaims {
  kind: "ws-ticket";
  sub: string;
  sessionExp: number;
  ticketId: string;
  iat: number;
  exp: number;
}

// A 60-second single-use ticket for one WebSocket upgrade. Minted by an
// authenticated POST, redeemed by the agent, which records the ticket ID
// so a replay fails. Never verifies as a session token: the kind differs.
export async function mintWsTicket(
  sub: string,
  sessionExp: number,
  secret: string,
  nowMs = Date.now(),
): Promise<{ ticket: string; ticketId: string; expiresAt: number }> {
  if (!sub || typeof sub !== "string") throw new Error("Ticket subject must be a non-empty string.");
  const ticketId = crypto.randomUUID();
  const claims: WsTicketClaims = {
    kind: "ws-ticket",
    sub,
    sessionExp,
    ticketId,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 60,
  };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`v1.${payload}`),
  );
  return { ticket: `v1.${payload}.${b64urlEncode(new Uint8Array(sig))}`, ticketId, expiresAt: nowMs + 60_000 };
}

export async function verifyWsTicket(
  ticket: string,
  secret: string,
  now = new Date(),
): Promise<WsTicketClaims | null> {
  try {
    const parts = ticket.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(parts[2]) as BufferSource,
      new TextEncoder().encode(`v1.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as WsTicketClaims;
    if (claims.kind !== "ws-ticket") return null;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.ticketId !== "string" || !claims.ticketId) return null;
    if (typeof claims.sessionExp !== "number") return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) return null;
    return { kind: "ws-ticket", sub: claims.sub, sessionExp: claims.sessionExp, ticketId: claims.ticketId, iat: claims.iat, exp: claims.exp };
  } catch {
    return null;
  }
}

// Service credentials. The agent never holds SESSION_SECRET, so it cannot
// mint a session for anyone. A service sends its own token as the Bearer
// and, in x-mano-handle-grant, the handle grant Channels signed for the
// person who just texted. Only that person's routes accept it, and only
// the routes in SERVICE_ROUTES for that service.
export const HANDLE_GRANT_HEADER = "x-mano-handle-grant";

export interface ServiceEnv {
  MANO_ENGINE_AGENT_TOKEN?: string;
  MANO_ENGINE_CHANNELS_TOKEN?: string;
  MANO_HANDLE_GRANT_SECRET?: string;
}

// Two services call person routes, each with its own token plus a handle
// grant: the agent on the routes it needs, Channels only to delete a
// conversation's state.
export type Service = "agent" | "channels";

const SERVICE_ROUTES: Record<Service, readonly (readonly [string, RegExp])[]> = {
  agent: [
    ["GET", /^\/memory$/],
    ["POST", /^\/memory$/],
    ["DELETE", /^\/memory\/[^/]+$/],
    ["POST", /^\/action$/],
    ["GET", /^\/approvals$/],
    ["POST", /^\/approvals\/[^/]+\/(approve|reject)$/],
    ["POST", /^\/approvals\/supersede$/],
    ["GET", /^\/reminders$/],
    ["POST", /^\/reminders$/],
    ["POST", /^\/reminders\/[^/]+\/cancel$/],
    ["POST", /^\/turns$/],
    ["GET", /^\/turns\/[^/]+$/],
    ["POST", /^\/turns\/[^/]+\/complete$/],
    ["GET", /^\/pending-approval$/],
    ["PUT", /^\/pending-approval$/],
    ["DELETE", /^\/pending-approval$/],
    ["GET", /^\/conversation$/],
    ["DELETE", /^\/conversation$/],
  ],
  channels: [["DELETE", /^\/conversation$/]],
};

export function serviceMayUse(service: Service, method: string, personRoute: string): boolean {
  return SERVICE_ROUTES[service].some(([m, path]) => m === method && path.test(personRoute));
}

// The calling service and the person it may act for, or null for any
// missing, wrong, forged or expired part. The grant secret unset closes
// both services; a service whose token is unset is closed.
export async function authenticateService(
  request: Request,
  env: ServiceEnv,
): Promise<{ service: Service; personId: string } | null> {
  if (!env.MANO_HANDLE_GRANT_SECRET) return null;
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  const service: Service | null =
    env.MANO_ENGINE_AGENT_TOKEN && timingSafeEqual(token, env.MANO_ENGINE_AGENT_TOKEN)
      ? "agent"
      : env.MANO_ENGINE_CHANNELS_TOKEN && timingSafeEqual(token, env.MANO_ENGINE_CHANNELS_TOKEN)
        ? "channels"
        : null;
  if (!service) return null;
  const grant = request.headers.get(HANDLE_GRANT_HEADER);
  if (!grant) return null;
  const claims = await verifyHandleGrant(grant, env.MANO_HANDLE_GRANT_SECRET);
  if (!claims) return null;
  return { service, personId: personIdForHandle(claims.handle) };
}
