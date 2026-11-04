// Mano engine: a Cloudflare Worker with one Agents SDK agent per person and
// per organization. Every outside action goes through the action gateway
// (src/gateway): decide, log, then act, and fail closed.
//
// Run and check:
//
//   pnpm --filter @mano/engine dev          # copy .dev.vars.example to .dev.vars first
//   pnpm --filter @mano/engine run check    # typecheck plus both test suites
//   pnpm --filter @mano/engine run smoke    # one live synthetic model call (needs META_MODEL_API_KEY)
//
// Without keys the engine runs on stand-ins in development only
// (MANO_ENV=development) and says so on /health, which reports ok:false
// until every required live part is present.
//
// Auth: person routes take a Bearer [REDACTED] session token whose subject matches
// the route; org routes take a staff token carrying the matching org ID.
// Minting and verification live in src/auth.ts; SESSION_SECRET signs the
// tokens. Without it (outside explicit development) every /api route is
// 503. Marking a person synthetic needs the operator secret on the admin
// route below.
//
// The agent (apps/agent) never holds SESSION_SECRET. It calls person
// routes with Bearer MANO_ENGINE_AGENT_TOKEN plus x-mano-handle-grant, a
// grant Channels signs with MANO_HANDLE_GRANT_SECRET for the handle that
// just texted (see packages/protocol handle-grant.ts). The grant names one
// person, handle-<hash>, and opens only the routes in auth.ts
// SERVICE_ROUTES: for the agent, memory, profile, action, approvals, its
// own state, deadlines, the person's documents (src/documents.ts) and
// reading a texted photo (GET /documents/:docId).
//
// HTTP surface:
//
//   GET  /health
//   POST /webhooks/mail, /webhooks/fax         provider delivery reports, verified by signature
//   POST /api/check-link                       { url } (person token; 200 with allowed:false when blocked)
//   POST /api/persons/:id/chat                 { message }
//   POST /api/persons/:id/action               action request (worker stamps personId from the token);
//                                              proposalTurn names the turn an agent draft belongs to
//   GET  /api/persons/:id/approvals
//   POST /api/persons/:id/approvals/supersede     { generation } closes every waiting draft but the latest
//   POST /api/persons/:id/approvals/:aid/approve  a YES; retryable:true when the safety check could not
//                                              answer and the approval still waits for another YES
//   POST /api/persons/:id/approvals/:aid/reject  a NO: ends a pending approval
//   PUT  /api/persons/:id/approvals/:aid/replay   { generation, labels, steps: [{ caption, pngB64 }] } (agent):
//                                              the screens of the fill behind a waiting approval; first bind wins.
//                                              201 or 200 with { path } of the page, 404 no approval,
//                                              409 no longer waiting. The caller joins the path to the
//                                              Engine address it uses: under wrangler dev a request's own
//                                              URL names the production route, not the local worker.
//   GET  /api/persons/:id/approvals/:aid/replay   { path } of the replay page while its link opens and the
//                                              approval still waits, unexpired and latest, under the
//                                              version the fill was bound to; else 404
//   GET  /fill/:token                          the replay page (src/fill-replay.ts): the token is the only key,
//                                              and the page asks the approval again on every view
//   GET  /api/persons/:id/memory
//   POST /api/persons/:id/memory              { content, source }
//   DELETE /api/persons/:id/memory/:memoryId  forget: deletes the row
//   GET  /api/persons/:id/profile              the person's structured record (src/profile.ts)
//   PATCH /api/persons/:id/profile             { idempotencyKey, source, documentId?, fields }
//   POST /api/persons/:id/deadlines           { title, dueDate, program?, source, idempotencyKey, generation }
//                                              (generation required, 409 when stale)
//   GET  /api/persons/:id/deadlines           (session or agent; nudges per deadline, see src/deadlines.ts)
//   PATCH /api/persons/:id/deadlines/:did     { dueDate?, title?, status?: "done" }
//   DELETE /api/persons/:id/deadlines/:did    stop tracking it
//
//   Service routes (agent token or Channels token, plus a handle grant;
//   the person must be handle-<hash> from the grant). Every write carries
//   the conversation generation it was prepared under and answers 409
//   when a delete has moved past it; services must send it on
//   POST /memory and POST /action too.
//   GET  /api/persons/:id/conversation         { generation } (agent)
//   DELETE /api/persons/:id/conversation       { generation } move to it, removing what the agent kept (agent, Channels)
//   POST /api/persons/:id/reminders            { id, text, dueAt, generation } (agent)
//   GET  /api/persons/:id/reminders            (agent)
//   POST /api/persons/:id/reminders/:rid/cancel  (agent)
//   POST /api/persons/:id/turns                { turnId, receivedAt, generation } (agent)
//   GET  /api/persons/:id/turns/:turnId        (agent)
//   POST /api/persons/:id/turns/:turnId/complete  { generation } (agent)
//   PUT  /api/persons/:id/pending-approval     { approvalId, generation } compare-and-set: only the latest proposal (agent)
//   GET  /api/persons/:id/pending-approval?generation=N  { pointer, latest } (agent)
//   DELETE /api/persons/:id/pending-approval   { approvalId, generation } compare-and-delete (agent)
//
// Due reminders go out from the person's one delivery wake-up through
// Channels' agent-send route at MANO_CHANNELS_URL, signed with
// MANO_ENGINE_SEND_SECRET (packages/protocol engine-send.ts).
//   POST /api/persons/:id/documents            { name, contentB64, id?, generation? } (Channels with a grant:
//                                              a texted photo under its own ID, generation required)
//   GET  /api/persons/:id/documents            { documents } this conversation's, newest first (src/documents.ts)
//   PATCH /api/persons/:id/documents/:docId    { kind, generation } what Mail found it to be (agent)
//   GET  /api/persons/:id/documents/:docId     decrypted bytes, owner only
//   POST /api/persons/:id/ws-ticket            one 60-second single-use ticket for /ws
//   GET  /api/persons/:id/ws?ticket=           chat socket (closes when the session expires)
//   GET  /api/orgs/:id/cases                   staff only
//   POST /api/admin/persons/:id/synthetic      { synthetic } (operator secret)
//
// Bodies are capped at about 1 MB for actions and 15 MB for uploads.
//
// Gateway and checker: src/gateway holds request validation, policy, link
// checks, the Checker hook, hash-bound approvals, single-flight attempts
// and timeout reconcile. With MANO_GUARDIAN_URL and MANO_GUARDIAN_TOKEN
// (plus MANO_GUARDIAN_KEY_ID and MANO_GUARDIAN_KEY_SECRET for Modal's
// proxy), every action gets the local rules and then Guardian before the
// person is asked, and again at their yes (src/gateway/guardian.ts).
// With none of them set the checker is local rules only. /health says
// which (live.checker), and a half-set Guardian config reports ok:false.
//
// Executors: EXECUTOR_MODE=simulated (explicit, or the default in
// development) records calls and labels receipts simulated, except share
// receipts, which are real deliveries. EXECUTOR_MODE=sandbox with
// SANDBOX_BASE_URL and SANDBOX_PORTAL_TOKEN files into the sandbox agency
// portal over its JSON API: POST {base}/submissions with the bearer token
// and { key, household, files } (the key is the SHA-256 of
// "<personId>:<idempotencyKey>", the file is the document the gateway
// verified) returns { confirmationNumber }; GET {base}/submissions/{key}
// returns it again, or 404. The portal files submits only, and only with
// every household field and a PDF, PNG or JPG document within its field
// and upload limits (SANDBOX_MAX_FIELD_LENGTH and SANDBOX_MAX_UPLOAD_BYTES in
// wrangler.toml, kept equal to the portal's), so in sandbox mode the
// gateway refuses anything else before it drafts an approval.
//
// Faxes and letters have their own executors, on only when their settings
// are present (gateway/outbound.ts). A fax goes only to our own number and
// a letter only to the mail provider's test mode, and the approval question
// shows the price Engine worked out for the exact document.
//
// Secrets: never put a key on a command line. Set secrets from stdin:
//
//   ~/Desktop/code/bin/ws keys run -- sh -c 'printf %s "$META_MODEL_API_KEY" | pnpm --filter @mano/engine exec wrangler secret put META_MODEL_API_KEY'
//
// Same for ENCRYPTION_KEK_B64 (32 bytes, base64), SESSION_SECRET and
// OPERATOR_SECRET, and the optional CF_ACCOUNT_ID, AI_GATEWAY_ID,
// AI_GATEWAY_PROVIDER, MODEL_ALLOWLIST_EXTRA, MANO_ENV, EXECUTOR_MODE,
// SANDBOX_BASE_URL, SANDBOX_PORTAL_TOKEN, MANO_GUARDIAN_URL,
// MANO_GUARDIAN_TOKEN, MANO_GUARDIAN_KEY_ID and MANO_GUARDIAN_KEY_SECRET.
//
// Deploy: ask David before the first deploy. After that, deploys go
// through GitHub by pushing. Never run a production deploy from a laptop.
import type { Env } from "./env.js";
import { PersonAgent } from "./agents/person-agent.js";
import {
  AgentStateInputError,
  parseGenerationInput,
  parsePointerInput,
  parseReminderInput,
  parseTurnInput,
  requireGeneration,
  requireIdentity,
} from "./agents/agent-state.js";
import { OrgAgent } from "./agents/org-agent.js";
import {
  HANDLE_GRANT_HEADER,
  authenticate,
  authenticateService,
  serviceMayUse,
  getSessionSecret,
  mintWsTicket,
  sessionConfigured,
} from "./auth.js";
import { checkerSetting, createExecutor, outboundProviders, parseFaxEvent, parseMailEvent, verifyFaxSignature, verifyMailSignature, type CheckerSetting } from "./gateway/index.js";
import { checkLinkSafety } from "./link-safety.js";
import { base64ToBytes } from "./hash.js";
import { profilePatchResponse } from "./profile.js";
import { routeDeadlines } from "./deadlines.js";
import {
  REPLAY_LINK_PATH,
  REPLAY_PAGE_HEADERS,
  ReplayInputError,
  linkKey,
  parseReplayInput,
  renderReplayPage,
  type ReplayLinkEntry,
} from "./fill-replay.js";
import { parseDocumentMark } from "./documents.js";

export { PersonAgent, OrgAgent };
export { ActionGateway, MemoryApprovalStore, InMemoryExecutor } from "./gateway/index.js";
export * from "./gateway/types.js";
export { checkLinkSafety } from "./link-safety.js";
export { extractEvidence, detectPlantedInstructions, wrapEvidenceForModel } from "./evidence.js";
export { MetaModelClient, StandInModelClient, createModelClient, buildModelBaseUrl } from "./model-client.js";
export { encryptForPerson, decryptForPerson, documentAad } from "./crypto.js";
export { putDocument, getDocumentBytes, documentR2Key } from "./files.js";
export { InMemorySharedStore } from "./shared-store.js";
export { sha256Hex } from "./hash.js";

function personStub(env: Env, personId: string) {
  return env.PERSON_AGENT.get(env.PERSON_AGENT.idFromName(personId));
}

function orgStub(env: Env, orgId: string) {
  return env.ORG_AGENT.get(env.ORG_AGENT.idFromName(orgId));
}

const FORBIDDEN = () => Response.json({ error: "Forbidden." }, { status: 403 });

// A write prepared under a conversation generation a delete has moved
// past: nothing was written. The answer carries no state of the new one.
const STALE = () =>
  Response.json({ error: "This conversation was deleted after the request was prepared. Nothing was written." }, { status: 409 });

function isStale<T>(value: T): value is Extract<T, { readonly stale: true }> {
  return typeof value === "object" && value !== null && (value as { stale?: unknown }).stale === true;
}

// A service must say which conversation generation it prepared a write
// under; a person's own session may omit it (the current one is used).
function writeGeneration(service: string | null, value: unknown): number | undefined | "invalid" {
  if (value === undefined) return service ? "invalid" : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : "invalid";
}

// Forward to an agent stub with caller identity headers stripped. Agents
// trust x-mano-subject and x-mano-ticket only because the worker is their
// only caller and always sets them from verified credentials.
async function forwardToAgent(
  stub: DurableObjectStub,
  path: string,
  request: Request,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-person-id" || lower.startsWith("x-mano-")) return;
    if (lower === "host" || lower === "content-length") return;
    headers.set(key, value);
  });
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return stub.fetch(new Request(new URL(path, "https://agent.internal"), init));
}

// Body caps: about 1 MB for actions, 15 MB for uploads. Both the declared
// length and the actual bytes are enforced.
const MAX_ACTION_BODY = 1_000_000;
const MAX_UPLOAD_BODY = 15_000_000;

async function readCappedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const tooLarge = () => ({ ok: false as const, response: Response.json({ error: "Request body is too large." }, { status: 413 }) });
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return tooLarge();
  // Bytes, not UTF-16 units: astral-plane text can be twice the capped
  // size in code units. Counted while streaming, chunk by chunk.
  if (!request.body) {
    try {
      return { ok: true, value: JSON.parse(await request.text()) };
    } catch {
      return { ok: false, response: Response.json({ error: "Invalid JSON." }, { status: 400 }) };
    }
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON." }, { status: 400 }) };
  }
}

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

// Which parts are live and which are stand-ins. Labels only: this is
// public, so it never carries values, only which side each part is on.
export interface LiveStatus {
  model: "meta" | "stand-in";
  modelVia: "ai-gateway" | "direct" | "none";
  executor: string;
  files: "bound" | "missing";
  kek: boolean;
  checker: CheckerSetting["kind"];
  mail: "test-mode" | "off";
  fax: "own-number" | "off";
}

export function liveStatus(env: Env): LiveStatus {
  const hasKey = Boolean(env.META_MODEL_API_KEY);
  const providers = outboundProviders(env);
  return {
    model: hasKey ? "meta" : "stand-in",
    modelVia: !hasKey ? "none" : env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID ? "ai-gateway" : "direct",
    executor: env.EXECUTOR_MODE ?? "simulated",
    files: env.FILES ? "bound" : "missing",
    kek: Boolean(env.ENCRYPTION_KEK_B64),
    checker: checkerSetting(env).kind,
    mail: providers.mail ? "test-mode" : "off",
    fax: providers.fax ? "own-number" : "off",
  };
}

// False when a required live part is missing, including an executor
// that cannot be constructed from config. Stand-ins keep local
// development running, but /health never reports a partial engine as ok.
export function healthOk(env: Env): boolean {
  if (
    !env.META_MODEL_API_KEY ||
    !env.ENCRYPTION_KEK_B64 ||
    !env.FILES ||
    !sessionConfigured(env) ||
    !env.MANO_ENGINE_AGENT_TOKEN ||
    !env.MANO_HANDLE_GRANT_SECRET ||
    !env.MANO_ENGINE_CHANNELS_TOKEN ||
    !env.MANO_CHANNELS_URL ||
    !env.MANO_ENGINE_SEND_SECRET
  ) {
    return false;
  }
  if (checkerSetting(env).kind === "guardian-misconfigured") return false;
  try {
    createExecutor(env);
  } catch {
    return false;
  }
  return true;
}

// A provider's report on a fax or letter. Closed until its secret is set,
// and nothing past the signature check runs on an unverified body. An
// event for nothing of ours is acknowledged and dropped.
async function deliveryWebhook(request: Request, env: Env, channel: "fax" | "mail"): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
  const secret = channel === "mail" ? env.LOB_WEBHOOK_SECRET : env.TELNYX_PUBLIC_KEY;
  if (!secret) return new Response("Not found.", { status: 404 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_ACTION_BODY) return new Response("Too large.", { status: 413 });
  const body = await request.text();
  if (body.length > MAX_ACTION_BODY) return new Response("Too large.", { status: 413 });
  const verified = channel === "mail" ? await verifyMailSignature(body, request.headers, secret) : await verifyFaxSignature(body, request.headers, secret);
  if (!verified) return new Response("Bad signature.", { status: 401 });
  const event = channel === "mail" ? parseMailEvent(body) : parseFaxEvent(body);
  if (event) await (personStub(env, event.personId) as unknown as PersonAgent).recordDelivery(event);
  return new Response(null, { status: 204 });
}

// Reminders, the turn ledger, the pending approval pointer and the
// conversation delete. Null when the route is none of these.
async function handleAgentState(
  agent: PersonAgent,
  subject: string,
  request: Request,
  rest: string,
  url: URL,
): Promise<Response | null> {
  const body = async (): Promise<Record<string, unknown>> => {
    const read = await readCappedJson(request, MAX_ACTION_BODY);
    if (!read.ok) throw read.response;
    const value = read.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw Response.json({ error: "Body must be a JSON object." }, { status: 400 });
    }
    return value as Record<string, unknown>;
  };
  const method = request.method;
  try {
    if (rest === "/reminders" && method === "POST") {
      const input = await body();
      parseReminderInput(input);
      const out = await agent.createReminder(subject, input);
      if (isStale(out)) return STALE();
      return Response.json(out, { status: out.status === "conflict" ? 409 : out.status === "created" ? 201 : 200 });
    }
    if (rest === "/reminders" && method === "GET") {
      return Response.json({ reminders: await agent.listReminders(subject) });
    }
    const cancelMatch = rest.match(/^\/reminders\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const out = await agent.cancelReminder(subject, requireIdentity(decodeURIComponent(cancelMatch[1])));
      if (!out.reminder) return Response.json({ error: "Reminder not found." }, { status: 404 });
      return Response.json(out);
    }
    if (rest === "/turns" && method === "POST") {
      const input = await body();
      parseTurnInput(input);
      const out = await agent.putTurn(subject, input);
      if (isStale(out)) return STALE();
      return Response.json(out, { status: out.created ? 201 : 200 });
    }
    const turnMatch = rest.match(/^\/turns\/([^/]+)(\/complete)?$/);
    if (turnMatch && ((method === "GET" && !turnMatch[2]) || (method === "POST" && turnMatch[2]))) {
      const turnId = requireIdentity(decodeURIComponent(turnMatch[1]));
      let turn;
      if (turnMatch[2]) {
        const input = await body();
        parseGenerationInput(input);
        turn = await agent.completeTurn(subject, turnId, input);
        if (isStale(turn)) return STALE();
      } else {
        turn = await agent.getTurn(subject, turnId);
      }
      if (!turn) return Response.json({ error: "Turn not found." }, { status: 404 });
      return Response.json({ turn });
    }
    if (rest === "/pending-approval" && method === "PUT") {
      const input = await body();
      parsePointerInput(input);
      const set = await agent.setPendingApproval(subject, input);
      if (isStale(set)) return STALE();
      if (!set) return Response.json({ error: "Approval not found." }, { status: 404 });
      return Response.json(set);
    }
    if (rest === "/pending-approval" && method === "GET") {
      const raw = url.searchParams.get("generation");
      const generation = raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      return Response.json(await agent.getPendingApproval(subject, requireGeneration(generation)));
    }
    if (rest === "/pending-approval" && method === "DELETE") {
      const input = await body();
      parsePointerInput(input);
      return Response.json(await agent.clearPendingApproval(subject, input));
    }
    if (rest === "/conversation" && method === "GET") {
      return Response.json(await agent.getConversation(subject));
    }
    if (rest === "/conversation" && method === "DELETE") {
      // The generation the delete moves to: Channels' new one. A retry
      // with the same generation answers the same and changes nothing.
      const input = await body().catch(() => {
        throw new AgentStateInputError("Body needs the generation the delete moves to.");
      });
      parseGenerationInput(input);
      return Response.json({ removed: await agent.deleteConversation(subject, input) });
    }
    return null;
  } catch (err) {
    if (err instanceof Response) return err;
    if (err instanceof AgentStateInputError) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    throw err;
  }
}

// A replay page by its link. The token's hash names the person and the
// approval; the person's agent checks its own row holds the same token.
// Anything else, an expired link included, gets the same 404 page.
async function fillReplayResponse(env: Env, pathname: string): Promise<Response> {
  const unavailable = (status: number) => new Response(renderReplayPage({ state: "missing" }), { status, headers: REPLAY_PAGE_HEADERS });
  const token = REPLAY_LINK_PATH.exec(pathname)?.[1];
  if (!token || !env.FILES) return unavailable(404);
  try {
    const stored = await env.FILES.get(await linkKey(token));
    if (!stored) return unavailable(404);
    const entry = JSON.parse(await stored.text()) as Partial<ReplayLinkEntry>;
    if (typeof entry.personId !== "string" || typeof entry.approvalId !== "string" || !(Number(entry.expiresAtMs) > Date.now())) {
      return unavailable(404);
    }
    const agent = personStub(env, entry.personId) as unknown as PersonAgent;
    const html = await agent.fillReplayPage(entry.personId, entry.approvalId, token);
    return html ? new Response(html, { headers: REPLAY_PAGE_HEADERS }) : unavailable(404);
  } catch {
    return unavailable(503);
  }
}

let loggedStartup = false;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!loggedStartup) {
      loggedStartup = true;
      console.info(`[mano] engine live: ${JSON.stringify(liveStatus(env))}`);
    }
    const url = new URL(request.url);

    if (url.pathname === "/health") return Response.json({ ok: healthOk(env), live: liveStatus(env) });

    if (url.pathname === "/fill" || url.pathname.startsWith("/fill/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed.", { status: 405 });
      return fillReplayResponse(env, url.pathname);
    }

    if (url.pathname === "/webhooks/mail" || url.pathname === "/webhooks/fax") {
      return deliveryWebhook(request, env, url.pathname === "/webhooks/mail" ? "mail" : "fax");
    }

    // Outside development, a partly configured engine answers only
    // /health: no business request runs while required config is missing.
    if (url.pathname.startsWith("/api/") && env.MANO_ENV !== "development" && !healthOk(env)) {
      return Response.json({ error: "The engine is not fully configured." }, { status: 503 });
    }

    // Without a session secret (and outside explicit development) no
    // authenticated route can verify anyone, so all of them fail closed.
    if (!sessionConfigured(env) && url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Sessions are not configured." }, { status: 503 });
    }

    if (url.pathname === "/api/check-link" && request.method === "POST") {
      const claims = await authenticate(request, env);
      if (!claims || claims.kind !== "person") return FORBIDDEN();
      const read = await readCappedJson(request, MAX_ACTION_BODY);
      if (!read.ok) return read.response;
      const body = read.value as { url: string };
      // A person-facing tool, so the server always applies the family
      // filter. Callers cannot downgrade it. A blocked link is a 200
      // with allowed:false, not an auth failure.
      const result = await checkLinkSafety(typeof body?.url === "string" ? body.url : "", { forDisplay: true });
      return Response.json(result);
    }

    const adminMatch = url.pathname.match(/^\/api\/admin\/persons\/([^/]+)\/synthetic$/);
    if (adminMatch && request.method === "POST") {
      if (!env.OPERATOR_SECRET) {
        return Response.json({ error: "Operator access is not configured." }, { status: 503 });
      }
      const token = bearerToken(request);
      if (!token || !secretsEqual(token, env.OPERATOR_SECRET)) return FORBIDDEN();
      const read = await readCappedJson(request, MAX_ACTION_BODY);
      if (!read.ok) return read.response;
      const synthetic = (read.value as { synthetic?: unknown })?.synthetic;
      if (typeof synthetic !== "boolean") {
        return Response.json({ error: "Body needs a synthetic boolean." }, { status: 400 });
      }
      const personId = decodeURIComponent(adminMatch[1]);
      await (personStub(env, personId) as unknown as PersonAgent).setSyntheticFlag(true, personId, synthetic);
      return Response.json({ ok: true, synthetic });
    }

    const personMatch = url.pathname.match(/^\/api\/persons\/([^/]+)(\/.*)?$/);
    if (personMatch) {
      const personId = decodeURIComponent(personMatch[1]);
      const rest = personMatch[2] ?? "";
      const stub = personStub(env, personId);
      const agent = stub as unknown as PersonAgent;
      if (rest === "/ws") {
        // Session tokens on the query string are gone: browsers upgrade
        // with a single-use ticket from the authenticated POST below.
        if (url.searchParams.has("token")) {
          return new Response("Query-string session tokens are removed. POST to /ws-ticket for a ticket.", {
            status: 400,
          });
        }
        const ticket = url.searchParams.get("ticket");
        if (!ticket) return FORBIDDEN();
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected websocket", { status: 426 });
        }
        // Redeemed here, before the SDK accepts the socket: the SDK sends
        // agent state on accept, so forwarding first would leak private
        // state to bad tickets. The ticket must name this route.
        const redeemed = await agent.redeemWsTicket(ticket, personId);
        if (!redeemed.ok) return FORBIDDEN();
        return forwardToAgent(stub, `/ws`, request, {
          "x-mano-subject": redeemed.subject,
          "x-mano-session-exp": String(redeemed.sessionExp),
        });
      }
      // Two kinds of caller: the person's own session, or a service (the
      // agent, or Channels) with a handle grant for exactly this person, on
      // that service's routes only. A grant header always means the service
      // path, never a session.
      let subject: string;
      let sessionExp: number | null = null;
      let service: "agent" | "channels" | null = null;
      if (request.headers.has(HANDLE_GRANT_HEADER)) {
        const caller = await authenticateService(request, env);
        if (!caller || caller.personId !== personId || !serviceMayUse(caller.service, request.method, rest)) return FORBIDDEN();
        subject = caller.personId;
        service = caller.service;
      } else {
        const claims = await authenticate(request, env);
        if (!claims || claims.kind !== "person" || claims.sub !== personId) return FORBIDDEN();
        subject = claims.sub;
        sessionExp = claims.exp;
      }
      // The agent's per-person state lives here, for services only.
      if (service) {
        const stateResponse = await handleAgentState(agent, subject, request, rest, url);
        if (stateResponse) return stateResponse;
      }
      const deadlines = await routeDeadlines(
        {
          track: (input) => agent.trackDeadline(subject, input),
          list: () => agent.listDeadlines(subject),
          update: (id, patch) => agent.updateDeadline(subject, id, patch),
          cancel: (id) => agent.cancelDeadline(subject, id),
        },
        request.method,
        rest,
        async () => {
          const read = await readCappedJson(request, MAX_ACTION_BODY);
          if (!read.ok) throw read.response;
          return read.value;
        },
      );
      if (deadlines) return deadlines;
      if (rest === "/ws-ticket" && request.method === "POST") {
        const configured = getSessionSecret(env);
        if (!configured || sessionExp === null) return Response.json({ error: "Sessions are not configured." }, { status: 503 });
        const ticket = await mintWsTicket(subject, sessionExp, configured.secret);
        return Response.json(ticket);
      }
      if (rest === "/chat" && request.method === "POST") {
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        const message = (read.value as { message?: unknown })?.message;
        const out = await agent.chat(typeof message === "string" ? message : "", subject);
        return Response.json(out);
      }
      if (rest === "/approvals" && request.method === "GET") {
        return Response.json({ approvals: await agent.listApprovals(subject) });
      }
      const replayMatch = rest.match(/^\/approvals\/([^/]+)\/replay$/);
      if (replayMatch && request.method === "PUT") {
        if (service !== "agent") return FORBIDDEN();
        const read = await readCappedJson(request, MAX_UPLOAD_BODY);
        if (!read.ok) return read.response;
        const generation = writeGeneration(service, (read.value as { generation?: unknown } | null)?.generation);
        if (generation === "invalid") return Response.json({ error: "Body needs a generation." }, { status: 400 });
        let input;
        try {
          input = parseReplayInput(read.value);
        } catch (err) {
          if (err instanceof ReplayInputError) return Response.json({ error: err.message }, { status: 400 });
          throw err;
        }
        const out = await agent.bindFillReplay(subject, decodeURIComponent(replayMatch[1]), input, generation);
        if (out.status === "stale") return STALE();
        if (out.status === "not_found") return Response.json({ error: "Approval not found." }, { status: 404 });
        if (out.status === "closed") return Response.json({ error: "That approval no longer waits for a yes." }, { status: 409 });
        return Response.json({ path: `/fill/${out.token}` }, { status: out.status === "created" ? 201 : 200 });
      }
      if (replayMatch && request.method === "GET") {
        const token = await agent.fillReplayLink(subject, decodeURIComponent(replayMatch[1]));
        if (!token) return Response.json({ error: "No replay for that approval." }, { status: 404 });
        return Response.json({ path: `/fill/${token}` });
      }
      if (rest === "/action" && request.method === "POST") {
        // The gateway binds the approval to the request's person ID, so the
        // worker stamps it from the verified token; client input is ignored.
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        const body = read.value;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return Response.json({ error: "Invalid action request." }, { status: 400 });
        }
        const generation = writeGeneration(service, (body as { generation?: unknown }).generation);
        if (generation === "invalid") return Response.json({ error: "Body needs a generation." }, { status: 400 });
        const result = await agent.requestAction({ ...body, personId: subject }, subject, generation);
        return Response.json(result);
      }
      if (rest === "/documents" && request.method === "POST") {
        const read = await readCappedJson(request, MAX_UPLOAD_BODY);
        if (!read.ok) return read.response;
        const { name, contentB64, id, generation: rawGeneration } = (read.value ?? {}) as {
          name?: unknown;
          contentB64?: unknown;
          id?: unknown;
          generation?: unknown;
        };
        if (typeof name !== "string" || typeof contentB64 !== "string" || (id !== undefined && typeof id !== "string")) {
          return Response.json({ error: "Body needs a name and contentB64." }, { status: 400 });
        }
        const generation = writeGeneration(service, rawGeneration);
        if (generation === "invalid") return Response.json({ error: "Body needs a generation." }, { status: 400 });
        try {
          const doc = await agent.registerDocument(subject, { name, contentB64, id }, generation);
          if (isStale(doc)) return STALE();
          if ("conflict" in doc) return Response.json({ error: "That document ID holds other content." }, { status: 409 });
          return Response.json(doc);
        } catch (err) {
          const message = (err as Error).message;
          const status = message.includes("ENCRYPTION_KEK_B64") ? 500 : 400;
          return Response.json({ error: message }, { status });
        }
      }
      if (rest === "/documents" && request.method === "GET") {
        return Response.json({ documents: await agent.listDocuments(subject) });
      }
      const documentMatch = rest.match(/^\/documents\/([^/]+)$/);
      if (documentMatch && request.method === "PATCH") {
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        let mark: ReturnType<typeof parseDocumentMark>;
        try {
          mark = parseDocumentMark(read.value);
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
        const id = decodeURIComponent(documentMatch[1]);
        const out = await agent.markDocument(subject, id, mark);
        if (out === "stale") return STALE();
        if (out === "missing") return Response.json({ error: "Document not found." }, { status: 404 });
        return Response.json({ id, kind: mark.kind });
      }
      if (documentMatch && request.method === "GET") {
        const docId = decodeURIComponent(documentMatch[1]);
        try {
          const doc = await agent.getDocument(subject, docId);
          const bytes = base64ToBytes(doc.contentB64);
          const filename = doc.name.replace(/["\r\n]/g, "_");
          return new Response(bytes as BodyInit, {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${filename}"`,
            },
          });
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes("not found")) return Response.json({ error: message }, { status: 404 });
          return Response.json({ error: message }, { status: 500 });
        }
      }
      if (rest === "/memory" && request.method === "GET") {
        return Response.json({ memories: await agent.listMemory(subject) });
      }
      if (rest === "/memory" && request.method === "POST") {
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        const { content, source, generation: rawGeneration } = (read.value ?? {}) as {
          content?: unknown;
          source?: unknown;
          generation?: unknown;
        };
        if (typeof content !== "string" || typeof source !== "string" || !content) {
          return Response.json({ error: "Body needs content and source strings." }, { status: 400 });
        }
        const generation = writeGeneration(service, rawGeneration);
        if (generation === "invalid") return Response.json({ error: "Body needs a generation." }, { status: 400 });
        const id = await agent.addMemory(subject, content, source, generation);
        if (isStale(id)) return STALE();
        return Response.json({ id });
      }
      const memoryMatch = rest.match(/^\/memory\/([^/]+)$/);
      if (memoryMatch && request.method === "DELETE") {
        return Response.json(await agent.forgetMemory(subject, decodeURIComponent(memoryMatch[1])));
      }
      if (rest === "/profile" && request.method === "GET") {
        const profile = await agent.getProfile(subject);
        if (!profile) return profilePatchResponse({ status: "unavailable" });
        return Response.json({ profile, suggestions: await agent.getProfileSuggestions(subject) });
      }
      if (rest === "/profile" && request.method === "PATCH") {
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        const generation = writeGeneration(service, (read.value as { generation?: unknown } | null)?.generation);
        if (generation === "invalid") return Response.json({ error: "Body needs a generation." }, { status: 400 });
        return profilePatchResponse(await agent.patchProfile(subject, read.value, generation));
      }
      if (rest === "/approvals/supersede" && request.method === "POST") {
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        const generation = writeGeneration(service, (read.value as { generation?: unknown } | null)?.generation);
        if (generation === "invalid") return Response.json({ error: "Body needs a generation." }, { status: 400 });
        const out = await agent.supersedeProposals(subject, generation);
        if (isStale(out)) return STALE();
        return Response.json(out);
      }
      const decisionMatch = rest.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
      if (decisionMatch && request.method === "POST") {
        const approvalId = decodeURIComponent(decisionMatch[1]);
        const result =
          decisionMatch[2] === "approve" ? await agent.approve(approvalId, subject) : await agent.reject(approvalId, subject);
        return Response.json(result);
      }
      // No model route: the agent calls the model client itself with the
      // synthetic flag from its own profile record. Callers never pick a
      // model ID.
      return new Response("Not found", { status: 404 });
    }

    const orgMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)(\/.*)?$/);
    if (orgMatch) {
      const orgId = decodeURIComponent(orgMatch[1]);
      const claims = await authenticate(request, env);
      if (!claims || claims.kind !== "staff" || claims.org !== orgId) return FORBIDDEN();
      const stub = orgStub(env, orgId);
      const rest = orgMatch[2] ?? "";
      // Cases reach the org only through consent messages from a person's
      // agent; there is deliberately no share route here.
      if (rest === "/cases" && request.method === "GET") {
        const cases = await (stub as unknown as OrgAgent).listCases(orgId);
        return Response.json({ cases });
      }
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
