// The routes behind the app's web build, apart from the Worker wiring so
// tests can run them on real SQLite:
//
//   POST /api/auth/request-code   { email } emails a 6-digit code
//   POST /api/auth/verify-code    { email, challengeId, code } opens a session
//   GET  /api/persons/:id/conversation   this person's web conversation
//   POST /api/persons/:id/chat    { message, clientOpId } one turn with Mano's agent
//
// Every other /api route answers 501, which the app shows as a part that
// is not on the web yet: those need an Engine session, and this Worker
// does not hold the Engine's session secret. A turn is the same turn the
// text line runs, with the same voice guard, link check and approval
// question, and nothing stands in when the agent cannot answer.

import {
  AGENT_PRESENTED_PATH,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  AGENT_TURN_PATH,
  APPROVAL_REFUSED_TEXT,
  LinkChecker,
  approvalSurvivesTextLine,
  boundFetch,
  finalizeReply,
  hashHandle,
  presentationHash,
  signAgentRequest,
} from "@mano/channels";
import { crisisGate, crisisLineFor } from "@mano/persona";
import { handleForPersonId, mintHandleGrant, personIdForHandle } from "@mano/protocol";

import { CODE_TTL_MS, addressHash, codesMatch, maskEmail, mintWebSession, normalizeEmail, signInCode, verifyWebSession } from "./auth.js";
import type { WebStore } from "./store.js";

type Async<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never };
export type StateStub = Async<Pick<WebStore, "allow" | "createChallenge" | "dropChallenge" | "spendChallenge" | "beginTurn" | "finishTurn" | "failTurn" | "listMessages">>;

export interface WebEnv {
  stateFor(name: string): StateStub;
  sendEmail(message: { to: string; from: { email: string; name: string }; subject: string; text: string }): Promise<unknown>;
  MANO_WEB_FROM?: string;
  MANO_HANDLE_GRANT_SECRET?: string;
  MANO_AGENT_SECRET?: string;
  MANO_HANDLE_PEPPER?: string;
  AGENT_URL?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const AGENT_TIMEOUT_MS = 100_000;
const MAX_AUTH_BODY = 4_096;
const MAX_CHAT_BODY = 16_384;
const MAX_MESSAGE_CHARS = 4_000;
const CODES_PER_ADDRESS_HOUR = 5;
const CODES_PER_IP_HOUR = 20;
const CODES_PER_DAY = 300;
const TURNS_PER_PERSON_HOUR = 60;
const TURNS_PER_DAY = 2_000;
// Separate from anything Channels hashes, so a web address and a texted
// handle never share a conversation number or generation.
const EMAIL_HANDLE_PREFIX = "web-email:";
// Channels owns deletion, which moves a conversation's generation; a web
// conversation is not deletable yet, so it stays on the first.
const WEB_GENERATION = 0;
const CHAT_PATH = /^\/api\/persons\/([^/]+)\/(chat|conversation)$/;

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > maxBytes) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function requestCode(request: Request, env: WebEnv, secret: string, nowMs: number): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY);
  const email = normalizeEmail(body?.email);
  if (!email) return error(400, "Enter a valid email address.");
  const from = env.MANO_WEB_FROM;
  if (!from) return error(503, "Sign-in email is not turned on yet.");
  const hash = await addressHash(secret, email);
  const auth = env.stateFor("auth");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed =
    (await auth.allow(`code:address:${hash}`, CODES_PER_ADDRESS_HOUR, HOUR_MS, nowMs)) &&
    (await auth.allow(`code:ip:${await addressHash(secret, ip)}`, CODES_PER_IP_HOUR, HOUR_MS, nowMs)) &&
    (await auth.allow("code:all", CODES_PER_DAY, DAY_MS, nowMs));
  if (!allowed) return error(429, "Too many codes. Try again in an hour.");
  const challengeId = crypto.randomUUID();
  await auth.createChallenge(challengeId, hash, nowMs + CODE_TTL_MS, nowMs);
  const code = await signInCode(secret, challengeId, email);
  try {
    await env.sendEmail({
      to: email,
      from: { email: from, name: "Mano" },
      subject: "Your Mano sign-in code",
      text: `Your Mano sign-in code is ${code}. It works for 10 minutes.\n\nIf you did not ask for this, you can ignore this email. Mano is an automated assistant.\n`,
    });
  } catch {
    await auth.dropChallenge(challengeId);
    return error(503, "Sign-in email is not turned on yet.");
  }
  return Response.json({ challengeId, maskedEmail: maskEmail(email) });
}

async function verifyCode(request: Request, env: WebEnv, secret: string, pepper: string, nowMs: number): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY);
  const email = normalizeEmail(body?.email);
  const { challengeId, code } = body ?? {};
  if (!email || typeof challengeId !== "string" || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return error(400, "That code did not work.");
  }
  const expected = await signInCode(secret, challengeId, email);
  const opened = await env.stateFor("auth").spendChallenge(challengeId, await addressHash(secret, email), codesMatch(code, expected), nowMs);
  if (!opened) return error(401, "That code did not work.");
  const personId = personIdForHandle(await hashHandle(`${EMAIL_HANDLE_PREFIX}${email}`, pepper));
  const { token, expiresAt } = await mintWebSession(secret, personId, nowMs);
  return Response.json({ token, personId, email, displayName: "", expiresAt });
}

async function signedAgentPost(env: WebEnv, secret: string, path: string, raw: string, nowMs: number, timeoutMs: number): Promise<Response> {
  const timestamp = Math.floor(nowMs / 1000);
  const fetchFn = env.fetchFn ?? boundFetch;
  return fetchFn(`${(env.AGENT_URL as string).replace(/\/$/, "")}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      [AGENT_TIMESTAMP_HEADER]: String(timestamp),
      [AGENT_SIGNATURE_HEADER]: await signAgentRequest(secret, timestamp, new TextEncoder().encode(raw)),
    },
    body: raw,
  });
}

// The reply the person sees, or null when the agent gave no answer. A
// question the guard or link check would change is refused here, as on
// the text line, so nobody says YES to words Engine did not freeze.
async function runTurn(
  env: WebEnv,
  grantSecret: string,
  handleHash: string,
  opTurn: { turn: number; receivedAt: number },
  message: string,
  nowMs: number,
): Promise<{ text: string; presented: { approvalId: string; approval: string } | null } | null> {
  const fetchFn = env.fetchFn ?? boundFetch;
  const raw = JSON.stringify({
    turnId: `${handleHash}:${WEB_GENERATION}:w${opTurn.turn}`,
    generation: WEB_GENERATION,
    receivedAt: opTurn.receivedAt,
    handleHash,
    grant: await mintHandleGrant(handleHash, grantSecret),
    texts: [message],
    attachmentCount: 0,
    documents: [],
  });
  const res = await signedAgentPost(env, env.MANO_AGENT_SECRET as string, AGENT_TURN_PATH, raw, nowMs, AGENT_TIMEOUT_MS);
  const data = (await res.json().catch(() => null)) as { status?: unknown; text?: unknown; approval?: unknown; approvalId?: unknown } | null;
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!res.ok || !text || (data?.status !== "replied" && data?.status !== "waiting_approval")) return null;
  const asking = data.status === "waiting_approval";
  if (asking && !approvalSurvivesTextLine(text, data.approval)) return { text: APPROVAL_REFUSED_TEXT, presented: null };
  const final = await finalizeReply(text, {
    crisis: crisisGate(message) !== "none",
    crisisLine: crisisLineFor(message),
    checker: new LinkChecker({ fetchFn }),
  });
  const shown = final.bubbles.join("\n\n");
  const presented =
    asking && typeof data.approvalId === "string" && typeof data.approval === "string" ? { approvalId: data.approvalId, approval: data.approval } : null;
  return { text: shown, presented };
}

// Tells the agent the question reached the person word for word, which
// is what makes their YES answerable. A failed report only means a YES
// has to be asked again.
async function reportPresented(env: WebEnv, grantSecret: string, handleHash: string, presented: { approvalId: string; approval: string }, nowMs: number): Promise<void> {
  const raw = JSON.stringify({
    handleHash,
    approvalId: presented.approvalId,
    textHash: await presentationHash(presented.approval),
    generation: WEB_GENERATION,
    grant: await mintHandleGrant(handleHash, grantSecret),
  });
  try {
    const res = await signedAgentPost(env, env.MANO_AGENT_SECRET as string, AGENT_PRESENTED_PATH, raw, nowMs, 15_000);
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) console.warn(JSON.stringify({ type: "web_presented_failed", status: res.status }));
  } catch {
    console.warn(JSON.stringify({ type: "web_presented_failed", status: null }));
  }
}

async function chat(request: Request, env: WebEnv, secret: string, personId: string, handleHash: string, nowMs: number): Promise<Response> {
  const body = await readJson(request, MAX_CHAT_BODY);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_CHARS) return error(400, "Send a message of up to 4,000 characters.");
  const opId = typeof body?.clientOpId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.clientOpId) ? body.clientOpId : crypto.randomUUID();
  const person = env.stateFor(`person:${personId}`);
  const allowed =
    (await person.allow("turns", TURNS_PER_PERSON_HOUR, HOUR_MS, nowMs)) && (await env.stateFor("auth").allow("turns:all", TURNS_PER_DAY, DAY_MS, nowMs));
  if (!allowed) return error(429, "That is a lot of messages. Try again in a while.");
  const start = await person.beginTurn(opId, message, nowMs);
  if (start.kind === "answered") return Response.json({ reply: start.reply.text });
  if (start.kind === "busy") return error(409, "Mano is still answering that message.");
  let result: Awaited<ReturnType<typeof runTurn>> = null;
  try {
    result = await runTurn(env, secret, handleHash, start, message, nowMs);
  } catch {
    result = null;
  }
  if (!result) {
    await person.failTurn(opId);
    return error(503, "Mano could not answer just now. Your message is saved; try again.");
  }
  const reply = await person.finishTurn(opId, result.text, (env.now ?? Date.now)());
  if (result.presented) await reportPresented(env, secret, handleHash, result.presented, (env.now ?? Date.now)());
  return Response.json({ reply: reply.text });
}

export async function handleApi(request: Request, env: WebEnv): Promise<Response> {
  const secret = env.MANO_HANDLE_GRANT_SECRET;
  const pepper = env.MANO_HANDLE_PEPPER;
  if (!secret || !pepper || !env.MANO_AGENT_SECRET || !env.AGENT_URL) return error(503, "Mano on the web is not configured.");
  const url = new URL(request.url);
  const nowMs = (env.now ?? Date.now)();
  if (request.method === "POST" && url.pathname === "/api/auth/request-code") return requestCode(request, env, secret, nowMs);
  if (request.method === "POST" && url.pathname === "/api/auth/verify-code") return verifyCode(request, env, secret, pepper, nowMs);

  const auth = request.headers.get("authorization");
  const claims = auth?.startsWith("Bearer ") ? await verifyWebSession(secret, auth.slice("Bearer ".length).trim(), nowMs) : null;
  if (!claims) return error(401, "Sign in again.");
  const match = CHAT_PATH.exec(url.pathname);
  if (match) {
    const handleHash = handleForPersonId(claims.sub);
    if (decodeURIComponent(match[1]) !== claims.sub || !handleHash) return error(403, "Sign in again.");
    if (match[2] === "conversation" && request.method === "GET") {
      return Response.json({ messages: await env.stateFor(`person:${claims.sub}`).listMessages(nowMs) });
    }
    if (match[2] === "chat" && request.method === "POST") return chat(request, env, secret, claims.sub, handleHash, nowMs);
  }
  return error(501, "This part of Mano is not on the web yet.");
}
