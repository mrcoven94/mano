import type { Env } from "./env.js";
import { PersonAgent } from "./agents/person-agent.js";
import { OrgAgent } from "./agents/org-agent.js";
import { authenticate } from "./auth.js";
import { checkLinkSafety } from "./link-safety.js";
import { MetaModelClient } from "./model-client.js";

export { PersonAgent, OrgAgent };
export { ActionGateway, MemoryApprovalStore, InMemoryExecutor } from "./gateway/index.js";
export * from "./gateway/types.js";
export { checkLinkSafety } from "./link-safety.js";
export { extractEvidence, detectPlantedInstructions, wrapEvidenceForModel } from "./evidence.js";
export { MetaModelClient } from "./model-client.js";
export { encryptForPerson, decryptForPerson } from "./crypto.js";
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
      const claims = await authenticate(request, env);
      if (!claims || claims.kind !== "person" || claims.sub !== personId) return FORBIDDEN();
      const stub = personStub(env, personId);
      const rest = personMatch[2] ?? "";
      if (rest === "/ws") {
        return forwardToAgent(stub, `/ws`, request, claims.sub);
      }
      if (rest === "/chat" && request.method === "POST") {
        return forwardToAgent(stub, `/chat`, request, claims.sub);
      }
      if (rest === "/approvals" && request.method === "GET") {
        return forwardToAgent(stub, `/approvals`, request, claims.sub);
      }
      if (rest === "/action" && request.method === "POST") {
        return forwardToAgent(stub, `/action`, request, claims.sub);
      }
      if (rest === "/model" && request.method === "POST") {
        const body = (await request.json()) as { input: string; synthetic: boolean };
        const client = new MetaModelClient({ apiKey: env.META_MODEL_API_KEY, gatewayBase: env.AI_GATEWAY_BASE });
        const out = await client.complete(body);
        return Response.json(out);
      }
      return new Response("Not found", { status: 404 });
    }

    const orgMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)(\/.*)?$/);
    if (orgMatch) {
      const orgId = decodeURIComponent(orgMatch[1]);
      const stub = orgStub(env, orgId);
      const rest = orgMatch[2] ?? "";
      if (rest === "/cases" && request.method === "GET") {
        return stub.fetch(new Request(new URL(`/cases`, url.origin), request));
      }
      if (rest === "/share" && request.method === "POST") {
        return stub.fetch(new Request(new URL(`/share`, url.origin), request));
      }
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
