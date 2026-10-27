import type { Env } from "./env.js";
import { PersonAgent } from "./agents/person-agent.js";
import { OrgAgent } from "./agents/org-agent.js";
import { authenticate, authenticateToken } from "./auth.js";
import { checkLinkSafety } from "./link-safety.js";

export { PersonAgent, OrgAgent };
export { ActionGateway, MemoryApprovalStore, InMemoryExecutor } from "./gateway/index.js";
export * from "./gateway/types.js";
export { checkLinkSafety } from "./link-safety.js";
export { extractEvidence, detectPlantedInstructions, wrapEvidenceForModel } from "./evidence.js";
export { MetaModelClient } from "./model-client.js";
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

// Forward to an agent stub with caller identity headers stripped and the
// verified subject attached. Agents trust x-mano-subject only because the
// worker is their only caller and always sets it from a verified token.
async function forwardToAgent(
  stub: DurableObjectStub,
  path: string,
  request: Request,
  subject: string,
): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-person-id" || lower === "x-mano-subject") return;
    if (lower === "host" || lower === "content-length") return;
    headers.set(key, value);
  });
  headers.set("x-mano-subject", subject);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return stub.fetch(new Request(new URL(path, "https://agent.internal"), init));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname === "/api/check-link" && request.method === "POST") {
      const body = (await request.json()) as { url: string; forDisplay?: boolean };
      const result = await checkLinkSafety(body.url, { forDisplay: body.forDisplay });
      return Response.json(result, { status: result.allowed ? 200 : 403 });
    }

    const personMatch = url.pathname.match(/^\/api\/persons\/([^/]+)(\/.*)?$/);
    if (personMatch) {
      const personId = decodeURIComponent(personMatch[1]);
      const rest = personMatch[2] ?? "";
      // Browsers cannot set headers on a WebSocket upgrade, so /ws also
      // accepts the session token as a query param. Everywhere else the
      // header is required.
      const queryToken = rest === "/ws" ? url.searchParams.get("token") : null;
      const claims =
        (await authenticate(request, env)) ??
        (queryToken ? await authenticateToken(queryToken, env) : null);
      if (!claims || claims.kind !== "person" || claims.sub !== personId) return FORBIDDEN();
      const stub = personStub(env, personId);
      const agent = stub as unknown as PersonAgent;
      if (rest === "/ws") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected websocket", { status: 426 });
        }
        return forwardToAgent(stub, `/ws`, request, claims.sub);
      }
      if (rest === "/chat" && request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON." }, { status: 400 });
        }
        const message = (body as { message?: unknown })?.message;
        const out = await agent.chat(typeof message === "string" ? message : "", claims.sub);
        return Response.json(out);
      }
      if (rest === "/approvals" && request.method === "GET") {
        return Response.json({ approvals: await agent.listApprovals(claims.sub) });
      }
      if (rest === "/action" && request.method === "POST") {
        // The gateway binds the approval to the request's person ID, so the
        // worker stamps it from the verified token; client input is ignored.
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON." }, { status: 400 });
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return Response.json({ error: "Invalid action request." }, { status: 400 });
        }
        const result = await agent.requestAction({ ...body, personId: claims.sub }, claims.sub);
        return Response.json(result);
      }
      if (rest === "/documents" && request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON." }, { status: 400 });
        }
        const { name, contentB64 } = (body ?? {}) as { name?: unknown; contentB64?: unknown };
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
