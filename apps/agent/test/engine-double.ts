// An in-process Engine for agent tests: Engine's real session-token
// verification and real action gateway (hash-bound approvals, the
// in-memory executor Engine uses for drills), behind the same person
// routes the agent calls. Only the Durable Object shell is replaced.
import { verifySessionToken } from "../../engine/src/auth.js";
import { ActionGateway, MemoryApprovalStore } from "../../engine/src/gateway/gateway.js";
import { InMemoryExecutor } from "../../engine/src/gateway/executors.js";

export const ENGINE_SECRET = "agent-test-engine-secret";
export const ENGINE_URL = "http://engine.test";

export class EngineDouble {
  store = new MemoryApprovalStore();
  executor = new InMemoryExecutor();
  gateway = new ActionGateway(this.store, this.executor, { linkCheck: async () => ({ allowed: true }) });
  memory = new Map<string, { id: string; content: string; source: string; created_at: string }[]>();
  requests: { method: string; path: string }[] = [];
  supportsMemoryDelete = false;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.requests.push({ method, path: url.pathname });
    const match = url.pathname.match(/^\/api\/persons\/([^/]+)(\/.*)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const personId = decodeURIComponent(match[1]);
    const rest = match[2];
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const claims = await verifySessionToken(auth.replace(/^Bearer /, ""), ENGINE_SECRET);
    if (!claims || claims.kind !== "person" || claims.sub !== personId) {
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
    if (memoryMatch && method === "DELETE" && this.supportsMemoryDelete) {
      this.memory.set(personId, rows.filter((r) => r.id !== decodeURIComponent(memoryMatch[1])));
      return Response.json({ ok: true });
    }
    if (rest === "/action" && method === "POST") {
      return Response.json(await this.gateway.requestAction({ ...body, personId: claims.sub }));
    }
    const approve = rest.match(/^\/approvals\/([^/]+)\/approve$/);
    if (approve && method === "POST") {
      return Response.json(await this.gateway.approveAndExecute(decodeURIComponent(approve[1]), claims.sub));
    }
    return new Response("Not found", { status: 404 });
  };

  approvals() {
    return [...this.store.approvals.values()];
  }
}
