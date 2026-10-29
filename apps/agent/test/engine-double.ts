// An in-process Engine for agent tests: Engine's real agent
// authentication (service token plus handle grant), real action gateway
// (hash-bound approvals, rejection, the in-memory executor Engine uses
// for drills), behind the same person routes the agent calls. Only the
// Durable Object shell is replaced.
import { mintHandleGrant } from "@mano/protocol";

import { agentMayUse, authenticateAgent } from "../../engine/src/auth.js";
import { ActionGateway, MemoryApprovalStore } from "../../engine/src/gateway/gateway.js";
import { InMemoryExecutor } from "../../engine/src/gateway/executors.js";

export const ENGINE_AGENT_TOKEN = "agent-test-engine-token";
export const GRANT_SECRET = "agent-test-grant-secret";
export const ENGINE_URL = "http://engine.test";

export function grantFor(handleHash: string): Promise<string> {
  return mintHandleGrant(handleHash, GRANT_SECRET);
}

export class EngineDouble {
  store = new MemoryApprovalStore();
  executor = new InMemoryExecutor();
  gateway = new ActionGateway(this.store, this.executor, { linkCheck: async () => ({ allowed: true }) });
  memory = new Map<string, { id: string; content: string; source: string; created_at: string }[]>();

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const match = url.pathname.match(/^\/api\/persons\/([^/]+)(\/.*)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const personId = decodeURIComponent(match[1]);
    const rest = match[2];
    const request = new Request(url, { method, headers: init?.headers });
    const caller = await authenticateAgent(request, {
      MANO_ENGINE_AGENT_TOKEN: ENGINE_AGENT_TOKEN,
      MANO_HANDLE_GRANT_SECRET: GRANT_SECRET,
    });
    if (!caller || caller.personId !== personId || !agentMayUse(method, rest)) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const rows = this.memory.get(personId) ?? [];
    if (rest === "/memory" && method === "GET") return Response.json({ memories: rows });
    if (rest === "/memory" && method === "POST") {
      const id = crypto.randomUUID();
      this.memory.set(personId, [...rows, { id, content: body.content, source: body.source, created_at: new Date().toISOString() }]);
      return Response.json({ id });
    }
    const memoryMatch = rest.match(/^\/memory\/([^/]+)$/);
    if (memoryMatch && method === "DELETE") {
      const id = decodeURIComponent(memoryMatch[1]);
      this.memory.set(personId, rows.filter((r) => r.id !== id));
      return Response.json({ id, forgotten: true });
    }
    if (rest === "/action" && method === "POST") {
      return Response.json(await this.gateway.requestAction({ ...body, personId }));
    }
    const decision = rest.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
    if (decision && method === "POST") {
      const id = decodeURIComponent(decision[1]);
      return Response.json(
        decision[2] === "approve" ? await this.gateway.approveAndExecute(id, personId) : await this.gateway.rejectApproval(id, personId),
      );
    }
    return new Response("Not found", { status: 404 });
  };

  approvals() {
    return [...this.store.approvals.values()];
  }
}
