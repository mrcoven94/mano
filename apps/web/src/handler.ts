// The routes behind the app's web build, apart from the Worker wiring so
// tests can run them on real SQLite:
//
//   POST /api/auth/request-code   { email } emails a 6-digit code
//   POST /api/auth/verify-code    { email, challengeId, code } opens a session
//   GET  /api/persons/:id/conversation   this person's web conversation
//   POST /api/persons/:id/chat    { message, clientOpId } one turn with Mano's agent
//   POST /api/persons/:id/approvals/:aid/shown   { messageId } the browser displayed the question
//
// Every other /api route answers 501, which the app shows as a part that
// is not on the web yet: those need an Engine session, and this Worker
// does not hold the Engine's session secret. A turn is the same turn the
// text line runs, with the same voice guard, link check and approval
// question, and nothing stands in when the agent cannot answer, except
// the fixed crisis line: a message that names a crisis gets 988 and 911
// whatever else is wrong, including a limit, an outage or a lost session.

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
import type { ShownQuestion, WebMessage, WebStore } from "./store.js";

type Async<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never };
export type StateStub = Async<Pick<WebStore, "allow" | "createChallenge" | "dropChallenge" | "spendChallenge" | "answered" | "beginTurn" | "finishTurn" | "failTurn" | "recordCrisis" | "questionToReport" | "settleQuestion" | "listMessages">>;

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
// Nobody in a crisis waits out a slow agent; the fixed line goes instead.
const CRISIS_AGENT_TIMEOUT_MS = 20_000;
const MAX_AUTH_BODY = 4_096;
// The most of one chat request ever read. Past this the message is refused,
// after a crisis check of what was read.
const MAX_CHAT_READ_BYTES = 256 * 1024;
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
const SHOWN_PATH = /^\/api\/persons\/([^/]+)\/approvals\/([^/]+)\/shown$/;
const SIX_DIGITS = /^\d{6}$/;
const TRAILING_SLASH = /\/$/;
const WHITESPACE_RUN = /\s+/g;
const CLIENT_OP_ID = /^[A-Za-z0-9_-]{1,100}$/;

const NOT_CONFIGURED = "Mano on the web is not configured.";
const SIGN_IN_AGAIN = "Sign in again.";
const COULD_NOT_ANSWER = "Mano could not answer just now. Your message is saved; try again.";

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function parseObject(raw: string, maxBytes: number): Record<string, unknown> | null {
  if (raw.length > maxBytes) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  return parseObject(await request.text(), maxBytes);
}

// The clock is read after any body is read: a body can be held open.
const currentTime = (env: WebEnv): number => (env.now ?? Date.now)();

async function sessionPerson(request: Request, env: WebEnv, secret: string): Promise<string | null> {
  const auth = request.headers.get("authorization");
  const claims = auth?.startsWith("Bearer ") ? await verifyWebSession(secret, auth.slice("Bearer ".length).trim(), currentTime(env)) : null;
  return claims?.sub ?? null;
}

async function requestCode(request: Request, env: WebEnv, secret: string): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY);
  const email = normalizeEmail(body?.email);
  if (!email) return error(400, "Enter a valid email address.");
  const from = env.MANO_WEB_FROM;
  if (!from) return error(503, "Sign-in email is not turned on yet.");
  const hash = await addressHash(secret, email);
  const auth = env.stateFor("auth");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed =
    (await auth.allow(`code:address:${hash}`, CODES_PER_ADDRESS_HOUR, HOUR_MS)) &&
    (await auth.allow(`code:ip:${await addressHash(secret, ip)}`, CODES_PER_IP_HOUR, HOUR_MS)) &&
    (await auth.allow("code:all", CODES_PER_DAY, DAY_MS));
  if (!allowed) return error(429, "Too many codes. Try again in an hour.");
  const challengeId = crypto.randomUUID();
  await auth.createChallenge(challengeId, hash, CODE_TTL_MS);
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

async function verifyCode(request: Request, env: WebEnv, secret: string, pepper: string): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY);
  const email = normalizeEmail(body?.email);
  const { challengeId, code } = body ?? {};
  if (!email || typeof challengeId !== "string" || typeof code !== "string" || !SIX_DIGITS.test(code)) {
    return error(400, "That code did not work.");
  }
  const expected = await signInCode(secret, challengeId, email);
  const opened = await env.stateFor("auth").spendChallenge(challengeId, await addressHash(secret, email), codesMatch(code, expected));
  if (!opened) return error(401, "That code did not work.");
  const personId = personIdForHandle(await hashHandle(`${EMAIL_HANDLE_PREFIX}${email}`, pepper));
  const { token, expiresAt } = await mintWebSession(secret, personId, currentTime(env));
  return Response.json({ token, personId, email, displayName: "", expiresAt });
}

async function signedAgentPost(env: WebEnv, secret: string, path: string, raw: string, timeoutMs: number): Promise<Response> {
  const timestamp = Math.floor(currentTime(env) / 1000);
  const fetchFn = env.fetchFn ?? boundFetch;
  return fetchFn(`${(env.AGENT_URL as string).replace(TRAILING_SLASH, "")}${path}`, {
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

const collapse = (text: string): string => text.replace(WHITESPACE_RUN, " ").trim();

// The reply the person sees, or null when the agent gave no answer. A
// question is armed only when every word of it is in what will be shown:
// the voice guard, the link check or the bubble cap could each remove it.
// Otherwise the person is told it was not asked, as on the text line, so
// nobody says YES to words they never saw.
async function runTurn(
  env: WebEnv,
  grantSecret: string,
  handleHash: string,
  opTurn: { turn: number; receivedAt: number },
  message: string,
  crisisLine: string | null,
): Promise<{ text: string; question: ShownQuestion | null } | null> {
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
  const res = await signedAgentPost(env, env.MANO_AGENT_SECRET as string, AGENT_TURN_PATH, raw, crisisLine ? CRISIS_AGENT_TIMEOUT_MS : AGENT_TIMEOUT_MS);
  const data = (await res.json().catch(() => null)) as { status?: unknown; text?: unknown; approval?: unknown; approvalId?: unknown } | null;
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!res.ok || !text || (data?.status !== "replied" && data?.status !== "waiting_approval")) return null;
  const finalize = async (reply: string): Promise<string> => {
    const final = await finalizeReply(reply, {
      crisis: crisisLine !== null,
      crisisLine: crisisLine ?? undefined,
      checker: new LinkChecker({ fetchFn }),
    });
    return final.bubbles.join("\n\n");
  };
  if (data.status === "replied") return { text: await finalize(text), question: null };
  const refused = async () => ({ text: await finalize(APPROVAL_REFUSED_TEXT), question: null });
  const { approval, approvalId } = data;
  if (typeof approvalId !== "string" || typeof approval !== "string" || !approvalSurvivesTextLine(text, approval)) return refused();
  const shown = await finalize(text);
  if (!collapse(shown).includes(collapse(approval))) return refused();
  return { text: shown, question: { approvalId, textHash: await presentationHash(approval) } };
}

// Reads a body up to a byte limit and stops, so a huge paste costs no more
// than the limit. truncated says there was more.
async function readCapped(request: Request, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    read += value.byteLength;
    text += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - Math.max(0, read - maxBytes))), { stream: true });
    if (read > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: text + decoder.decode(), truncated: true };
    }
  }
}

// An operation answers only for the message it was first sent with. The
// same ID on different words is a different operation, so a cached reply
// can never stand in for what the person just wrote.
async function operationKey(opId: string, message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${opId}-${hex.slice(0, 16)}`;
}

const chatAnswer = (message: WebMessage): Response =>
  Response.json({ id: message.id, reply: message.text, createdAt: message.createdAt, ...(message.ask ? { ask: message.ask } : {}) });

async function chat(request: Request, env: WebEnv, personSegment: string): Promise<Response> {
  const { text: raw, truncated } = await readCapped(request, MAX_CHAT_READ_BYTES);
  const body = truncated ? null : parseObject(raw, MAX_CHAT_READ_BYTES);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  // A message too long to take, or a body too big to parse, is still read
  // for the crisis check.
  const said = message || raw;
  const crisisLine = crisisGate(said) !== "none" ? crisisLineFor(said) : null;
  const clientOp = typeof body?.clientOpId === "string" && CLIENT_OP_ID.test(body.clientOpId) ? body.clientOpId : crypto.randomUUID();
  const opId = await operationKey(clientOp, said);
  let person: StateStub | null = null;

  // Every way a message can fail ends here, so a crisis always gets its line.
  const refuse = async (status: number, words: string): Promise<Response> => {
    if (!crisisLine) return error(status, words);
    const unsaved = (): WebMessage => ({ id: `crisis-${opId}`, role: "agent", text: crisisLine, createdAt: new Date(currentTime(env)).toISOString() });
    try {
      return chatAnswer(person ? await person.recordCrisis(opId, message.slice(0, MAX_MESSAGE_CHARS), crisisLine) : unsaved());
    } catch {
      return chatAnswer(unsaved());
    }
  };

  try {
    const secret = env.MANO_HANDLE_GRANT_SECRET;
    if (!secret || !env.MANO_HANDLE_PEPPER || !env.MANO_AGENT_SECRET || !env.AGENT_URL) return await refuse(503, NOT_CONFIGURED);
    const personId = await sessionPerson(request, env, secret);
    if (!personId) return await refuse(401, SIGN_IN_AGAIN);
    const handleHash = handleForPersonId(personId);
    if (decodeURIComponent(personSegment) !== personId || !handleHash) return await refuse(403, SIGN_IN_AGAIN);
    person = env.stateFor(`person:${personId}`);
    if (!message || message.length > MAX_MESSAGE_CHARS) return await refuse(400, "Send a message of up to 4,000 characters.");
    // A retry of an answered message spends nothing, and its reply is for
    // these same words: a crisis reply already leads with the crisis line.
    const answered = await person.answered(opId);
    if (answered) return chatAnswer(answered);
    const allowed = (await person.allow("turns", TURNS_PER_PERSON_HOUR, HOUR_MS)) && (await env.stateFor("auth").allow("turns:all", TURNS_PER_DAY, DAY_MS));
    if (!allowed) return await refuse(429, "That is a lot of messages. Try again in a while.");
    const start = await person.beginTurn(opId, message);
    if (start.kind === "answered") return chatAnswer(start.reply);
    if (start.kind === "busy") return await refuse(409, "Mano is still answering that message.");
    const result = await runTurn(env, secret, handleHash, start, message, crisisLine).catch(() => null);
    if (!result) {
      await person.failTurn(opId);
      return await refuse(503, COULD_NOT_ANSWER);
    }
    return chatAnswer(await person.finishTurn(opId, result.text, result.question));
  } catch {
    return await refuse(503, COULD_NOT_ANSWER);
  }
}

// The browser saying it displayed a question. Only this makes the person's
// YES answerable: a response lost on the way never armed anything. It takes
// the signed-in person, the approval and the message that carried it. The
// agent's own check still decides, so a repeat or a stale report changes
// nothing. An outage leaves it waiting for the next try.
async function questionShown(request: Request, env: WebEnv, secret: string, personSegment: string, approvalId: string): Promise<Response> {
  const body = await readJson(request, MAX_AUTH_BODY);
  const personId = await sessionPerson(request, env, secret);
  if (!personId) return error(401, SIGN_IN_AGAIN);
  const handleHash = handleForPersonId(personId);
  if (decodeURIComponent(personSegment) !== personId || !handleHash) return error(403, SIGN_IN_AGAIN);
  const messageId = body?.messageId;
  const person = env.stateFor(`person:${personId}`);
  const textHash = typeof messageId === "string" ? await person.questionToReport(approvalId, messageId) : null;
  if (typeof messageId !== "string" || !textHash) return error(409, "That question is not waiting.");
  const raw = JSON.stringify({
    handleHash,
    approvalId,
    textHash,
    generation: WEB_GENERATION,
    grant: await mintHandleGrant(handleHash, secret),
  });
  const res = await signedAgentPost(env, env.MANO_AGENT_SECRET as string, AGENT_PRESENTED_PATH, raw, 15_000).catch(() => null);
  await res?.body?.cancel().catch(() => undefined);
  if (res?.ok) {
    await person.settleQuestion(approvalId, messageId, "reported");
    return Response.json({ ok: true });
  }
  if (res?.status === 409) {
    await person.settleQuestion(approvalId, messageId, "closed");
    return error(409, "That question is not waiting.");
  }
  console.warn(JSON.stringify({ type: "web_presented_failed", status: res?.status ?? null }));
  return error(503, COULD_NOT_ANSWER);
}

export async function handleApi(request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url);
  const chatMatch = CHAT_PATH.exec(url.pathname);
  if (chatMatch?.[2] === "chat" && request.method === "POST") return chat(request, env, chatMatch[1]);

  const secret = env.MANO_HANDLE_GRANT_SECRET;
  const pepper = env.MANO_HANDLE_PEPPER;
  if (!secret || !pepper || !env.MANO_AGENT_SECRET || !env.AGENT_URL) return error(503, NOT_CONFIGURED);
  if (request.method === "POST" && url.pathname === "/api/auth/request-code") return requestCode(request, env, secret);
  if (request.method === "POST" && url.pathname === "/api/auth/verify-code") return verifyCode(request, env, secret, pepper);
  const shownMatch = SHOWN_PATH.exec(url.pathname);
  if (shownMatch && request.method === "POST") return questionShown(request, env, secret, shownMatch[1], decodeURIComponent(shownMatch[2]));

  const personId = await sessionPerson(request, env, secret);
  if (!personId) return error(401, SIGN_IN_AGAIN);
  if (chatMatch) {
    if (decodeURIComponent(chatMatch[1]) !== personId || !handleForPersonId(personId)) return error(403, SIGN_IN_AGAIN);
    if (chatMatch[2] === "conversation" && request.method === "GET") {
      return Response.json({ messages: await env.stateFor(`person:${personId}`).listMessages() });
    }
  }
  return error(501, "This part of Mano is not on the web yet.");
}
