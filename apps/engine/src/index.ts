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
// HTTP surface:
//
//   GET  /health
//   POST /api/check-link                       { url } (person token; 200 with allowed:false when blocked)
//   POST /api/persons/:id/chat                 { message }
//   POST /api/persons/:id/action               action request (worker stamps personId from the token)
//   GET  /api/persons/:id/approvals
//   POST /api/persons/:id/approvals/:aid/approve
//   POST /api/persons/:id/documents            { name, contentB64 }
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
// and timeout reconcile. The checker shape (CheckInput, CheckResult,
// Checker) is the Guardian session's contract; LocalRulesChecker is the
// default until it lands.
//
// Executors: EXECUTOR_MODE=simulated (explicit, or the default in
// development) records calls and labels receipts simulated, except share
// receipts, which are real deliveries. EXECUTOR_MODE=sandbox with
// SANDBOX_BASE_URL files into the sandbox agency portal:
// POST {base}/v1/actions with the action JSON (idempotencyKey scoped as
// "<personId>:<key>", plus document {hash, contentB64} when the gateway
// verified one) returns { externalId }; GET
// {base}/v1/actions/by-key/{key} returns {externalId} or 404.
//
// Secrets: never put a key on a command line. Set secrets from stdin:
//
//   ~/Desktop/code/bin/ws keys run -- sh -c 'printf %s "$META_MODEL_API_KEY" | pnpm --filter @mano/engine exec wrangler secret put META_MODEL_API_KEY'
//
// Same for ENCRYPTION_KEK_B64 (32 bytes, base64), SESSION_SECRET and
// OPERATOR_SECRET, and the optional CF_ACCOUNT_ID, AI_GATEWAY_ID,
// AI_GATEWAY_PROVIDER, MODEL_ALLOWLIST_EXTRA, MANO_ENV, EXECUTOR_MODE,
// SANDBOX_BASE_URL.
//
// Deploy: ask David before the first deploy. After that, deploys go
// through GitHub by pushing. Never run a production deploy from a laptop.
import type { Env } from "./env.js";
import { PersonAgent } from "./agents/person-agent.js";
import { OrgAgent } from "./agents/org-agent.js";
import { authenticate, getSessionSecret, mintWsTicket, sessionConfigured } from "./auth.js";
import { createExecutor } from "./gateway/index.js";
import { checkLinkSafety } from "./link-safety.js";
import { base64ToBytes } from "./hash.js";

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
}

export function liveStatus(env: Env): LiveStatus {
  const hasKey = Boolean(env.META_MODEL_API_KEY);
  return {
    model: hasKey ? "meta" : "stand-in",
    modelVia: !hasKey ? "none" : env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID ? "ai-gateway" : "direct",
    executor: env.EXECUTOR_MODE ?? "simulated",
    files: env.FILES ? "bound" : "missing",
    kek: Boolean(env.ENCRYPTION_KEK_B64),
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
    !sessionConfigured(env)
  ) {
    return false;
  }
  try {
    createExecutor(env);
  } catch {
    return false;
  }
  return true;
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
      const claims = await authenticate(request, env);
      if (!claims || claims.kind !== "person" || claims.sub !== personId) return FORBIDDEN();
      if (rest === "/ws-ticket" && request.method === "POST") {
        const configured = getSessionSecret(env);
        if (!configured) return Response.json({ error: "Sessions are not configured." }, { status: 503 });
        const ticket = await mintWsTicket(claims.sub, claims.exp, configured.secret);
        return Response.json(ticket);
      }
      if (rest === "/chat" && request.method === "POST") {
        const read = await readCappedJson(request, MAX_ACTION_BODY);
        if (!read.ok) return read.response;
        const message = (read.value as { message?: unknown })?.message;
        const out = await agent.chat(typeof message === "string" ? message : "", claims.sub);
        return Response.json(out);
      }
      if (rest === "/approvals" && request.method === "GET") {
        return Response.json({ approvals: await agent.listApprovals(claims.sub) });
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
        const result = await agent.requestAction({ ...body, personId: claims.sub }, claims.sub);
        return Response.json(result);
      }
      if (rest === "/documents" && request.method === "POST") {
        const read = await readCappedJson(request, MAX_UPLOAD_BODY);
        if (!read.ok) return read.response;
        const { name, contentB64 } = (read.value ?? {}) as { name?: unknown; contentB64?: unknown };
        if (typeof name !== "string" || typeof contentB64 !== "string") {
          return Response.json({ error: "Body needs a name and contentB64." }, { status: 400 });
        }
        try {
          const doc = await agent.registerDocument(claims.sub, { name, contentB64 });
          return Response.json(doc);
        } catch (err) {
          const message = (err as Error).message;
          const status = message.includes("ENCRYPTION_KEK_B64") ? 500 : 400;
          return Response.json({ error: message }, { status });
        }
      }
      const documentMatch = rest.match(/^\/documents\/([^/]+)$/);
      if (documentMatch && request.method === "GET") {
        const docId = decodeURIComponent(documentMatch[1]);
        try {
          const doc = await agent.getDocument(claims.sub, docId);
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
      const approveMatch = rest.match(/^\/approvals\/([^/]+)\/approve$/);
      if (approveMatch && request.method === "POST") {
        const approvalId = decodeURIComponent(approveMatch[1]);
        const result = await agent.approve(approvalId, claims.sub);
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
