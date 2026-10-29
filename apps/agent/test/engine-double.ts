// An in-process Engine for agent tests: Engine's real service
// authentication (agent token plus handle grant), its real action
// gateway (hash-bound approvals, rejection, the in-memory executor Engine
// uses for drills) and its real agent-state SQL (reminders, turn ledger,
// approval pointer) on node:sqlite, behind the same person routes the
// agent calls. Only the Durable Object shell and its alarm are replaced:
// deliverDue() runs the claim the alarm would.
import { DatabaseSync } from "node:sqlite";

import { mintHandleGrant } from "@mano/protocol";

import {
  cancelReminder,
  claimDueReminders,
  completeTurn,
  createReminder,
  clearPendingPointer,
  ensureAgentStateTables,
  finishReminder,
  getPendingPointer,
  listReminders,
  parsePointerInput,
  parseReminderInput,
  parseTurnInput,
  putTurnIfAbsent,
  setPendingPointer,
  AgentStateInputError,
} from "../../engine/src/agents/agent-state.js";
import { authenticateService, serviceMayUse } from "../../engine/src/auth.js";
import { ActionGateway, MemoryApprovalStore } from "../../engine/src/gateway/gateway.js";
import { InMemoryExecutor } from "../../engine/src/gateway/executors.js";

export const ENGINE_AGENT_TOKEN = "agent-test-engine-token";
export const GRANT_SECRET = "agent-test-grant-secret";
export const ENGINE_URL = "http://engine.test";

export function grantFor(handleHash: string): Promise<string> {
  return mintHandleGrant(handleHash, GRANT_SECRET);
}

function sqlite() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const head = query.trimStart().toUpperCase();
      if (head.startsWith("SELECT")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureAgentStateTables(sql);
  return sql;
}

interface Person {
  sql: ReturnType<typeof sqlite>;
  memory: { id: string; content: string; source: string; created_at: string }[];
}

export class EngineDouble {
  store = new MemoryApprovalStore();
  executor = new InMemoryExecutor();
  gateway = new ActionGateway(this.store, this.executor, { linkCheck: async () => ({ allowed: true }) });
  persons = new Map<string, Person>();
  now = () => Date.now();

  person(personId: string): Person {
    let p = this.persons.get(personId);
    if (!p) {
      p = { sql: sqlite(), memory: [] };
      this.persons.set(personId, p);
    }
    return p;
  }

  memoryOf(personId: string): string[] {
    return this.person(personId).memory.map((m) => m.content);
  }

  remindersOf(personId: string) {
    return listReminders(this.person(personId).sql);
  }

  // What Engine's alarm does when reminders fall due: claim them, and
  // settle each as sent. Returns what it would have delivered.
  deliverDue(personId: string): { id: string; text: string; generation: number }[] {
    const { sql } = this.person(personId);
    const token = crypto.randomUUID();
    const claimed = claimDueReminders(sql, this.now(), 120_000, token);
    for (const r of claimed) finishReminder(sql, r.id, token, { kind: "sent" }, this.now());
    return claimed.map((r) => ({ id: r.id, text: r.text, generation: r.generation }));
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const match = url.pathname.match(/^\/api\/persons\/([^/]+)(\/.*)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const personId = decodeURIComponent(match[1]);
    const rest = match[2];
    const caller = await authenticateService(new Request(url, { method, headers: init?.headers }), {
      MANO_ENGINE_AGENT_TOKEN: ENGINE_AGENT_TOKEN,
      MANO_HANDLE_GRANT_SECRET: GRANT_SECRET,
    });
    if (!caller || caller.personId !== personId || !serviceMayUse(caller.service, method, rest)) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = this.person(personId);
    try {
      if (rest === "/memory" && method === "GET") return Response.json({ memories: p.memory });
      if (rest === "/memory" && method === "POST") {
        const id = crypto.randomUUID();
        p.memory.push({ id, content: body.content, source: body.source, created_at: new Date().toISOString() });
        return Response.json({ id });
      }
      const memoryMatch = rest.match(/^\/memory\/([^/]+)$/);
      if (memoryMatch && method === "DELETE") {
        const id = decodeURIComponent(memoryMatch[1]);
        p.memory = p.memory.filter((r) => r.id !== id);
        return Response.json({ id, forgotten: true });
      }
      if (rest === "/approvals" && method === "GET") {
        // outcome is the field the agent asks Engine to add (PR 60).
        const approvals = this.approvals()
          .filter((a) => a.personId === personId)
          .map((a) => {
            const attempt = this.store.getAttempt(a.idempotencyKey);
            const receipt = this.store.getReceiptByKey(a.idempotencyKey);
            return {
              ...a,
              outcome: {
                attempt: attempt?.status ?? null,
                receipt: receipt ? { externalId: receipt.externalId, simulated: receipt.simulated } : null,
              },
            };
          });
        return Response.json({ approvals });
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
      if (rest === "/reminders" && method === "POST") {
        const out = createReminder(p.sql, parseReminderInput(body), this.now());
        if ("conflict" in out) return Response.json({ status: "conflict", reminder: out.conflict }, { status: 409 });
        return Response.json({ status: out.created ? "created" : "existing", reminder: out.reminder }, { status: out.created ? 201 : 200 });
      }
      if (rest === "/reminders" && method === "GET") return Response.json({ reminders: listReminders(p.sql) });
      const cancelMatch = rest.match(/^\/reminders\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        const out = cancelReminder(p.sql, decodeURIComponent(cancelMatch[1]), this.now());
        if (!out.reminder) return Response.json({ error: "Reminder not found." }, { status: 404 });
        return Response.json(out);
      }
      if (rest === "/turns" && method === "POST") {
        const input = parseTurnInput(body);
        const out = putTurnIfAbsent(p.sql, input.turnId, input.receivedAt);
        return Response.json(out, { status: out.created ? 201 : 200 });
      }
      const complete = rest.match(/^\/turns\/([^/]+)\/complete$/);
      if (complete && method === "POST") {
        const turn = completeTurn(p.sql, decodeURIComponent(complete[1]), new Date(this.now()).toISOString());
        if (!turn) return Response.json({ error: "Turn not found." }, { status: 404 });
        return Response.json({ turn });
      }
      if (rest === "/pending-approval" && method === "PUT") {
        const input = parsePointerInput(body);
        const owned = this.store.getApproval(input.approvalId);
        if (!owned || owned.personId !== personId) return Response.json({ error: "Approval not found." }, { status: 404 });
        return Response.json({ pointer: setPendingPointer(p.sql, input.approvalId, input.generation, new Date(this.now()).toISOString()) });
      }
      if (rest === "/pending-approval" && method === "GET") {
        return Response.json({ pointer: getPendingPointer(p.sql, Number(url.searchParams.get("generation"))) });
      }
      if (rest === "/pending-approval" && method === "DELETE") return Response.json({ cleared: clearPendingPointer(p.sql) });
    } catch (err) {
      if (err instanceof AgentStateInputError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
    return new Response("Not found", { status: 404 });
  };

  approvals() {
    return [...this.store.approvals.values()];
  }
}
