// An in-process Engine for agent tests, built from Engine's own code:
// its service authentication (agent token plus handle grant), its action
// gateway over its SQL approval store, and its agent-state SQL
// (generation fence, reminders, turn ledger, approval pointer,
// conversation delete), all on one node:sqlite database per person, the
// way each PersonAgent keeps them in its own SQLite. Only the Durable
// Object shell and its alarm are replaced: deliverDue() claims and hands
// off due reminders the way the alarm does.
import { DatabaseSync } from "node:sqlite";

import { mintHandleGrant } from "@mano/protocol";

import {
  AgentStateInputError,
  cancelReminder,
  claimDueReminders,
  clearPendingPointer,
  completeTurn,
  createReminder,
  currentGeneration,
  ensureAgentStateTables,
  finishReminder,
  getPendingPointer,
  getTurn,
  handOffReminder,
  listReminders,
  parseGenerationInput,
  parsePointerInput,
  proposalOrderFor,
  splitProposalTurn,
  parseReminderInput,
  parseTurnInput,
  putTurnIfAbsent,
  removeConversationState,
  setPendingPointer,
} from "../../engine/src/agents/agent-state.js";
import { authenticateService, serviceMayUse } from "../../engine/src/auth.js";
import { ActionGateway } from "../../engine/src/gateway/gateway.js";
import { InMemoryExecutor } from "../../engine/src/gateway/executors.js";
import { CURRENT_GENERATION, SqlApprovalStore, ensureGatewayTables } from "../../engine/src/gateway/sql-store.js";

export const ENGINE_AGENT_TOKEN = "agent-test-engine-token";
export const ENGINE_CHANNELS_TOKEN = "channels-test-engine-token";
export const GRANT_SECRET = "agent-test-grant-secret";
export const ENGINE_URL = "http://engine.test";

const STALE = { error: "This conversation was deleted after the request was prepared. Nothing was written." };

export function grantFor(handleHash: string): Promise<string> {
  return mintHandleGrant(handleHash, GRANT_SECRET);
}

function sqlite() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const head = query.trimStart().toUpperCase();
      if (head.startsWith("SELECT") || head.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureGatewayTables(sql as never);
  ensureAgentStateTables(sql);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0)",
  );
  return sql;
}

interface Person {
  sql: ReturnType<typeof sqlite>;
  store: SqlApprovalStore;
  gateway: ActionGateway;
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface DeadlineCall {
  personId: string;
  body: Record<string, unknown>;
}

export class EngineDouble {
  executor = new InMemoryExecutor();
  persons = new Map<string, Person>();
  now = () => Date.now();
  // Texted photos Channels stored, by person and document ID.
  documents = new Map<string, Uint8Array>();
  // POST /deadlines is the Deadlines session's route: until it exists
  // Engine answers 404. With deadlinesLive, each call is recorded, and
  // one idempotency key is one deadline.
  deadlinesLive = true;
  deadlineCalls: DeadlineCall[] = [];

  putDocument(personId: string, documentId: string, bytes: Uint8Array): void {
    this.documents.set(`${personId}/${documentId}`, bytes);
  }

  deadlinesOf(personId: string): Record<string, unknown>[] {
    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of this.deadlineCalls) if (c.personId === personId) byKey.set(String(c.body.idempotencyKey), c.body);
    return [...byKey.values()];
  }

  person(personId: string): Person {
    let p = this.persons.get(personId);
    if (!p) {
      const sql = sqlite();
      const store = new SqlApprovalStore(sql as never);
      p = { sql, store, gateway: new ActionGateway(store, this.executor, { linkCheck: async () => ({ allowed: true }) }) };
      this.persons.set(personId, p);
    }
    return p;
  }

  gatewayFor(personId: string): ActionGateway {
    return this.person(personId).gateway;
  }

  memoryOf(personId: string): string[] {
    return (this.person(personId).sql.exec("SELECT content FROM memory ORDER BY created_at").toArray() as { content: string }[]).map(
      (r) => r.content,
    );
  }

  remindersOf(personId: string) {
    return listReminders(this.person(personId).sql);
  }

  // What Engine's alarm does when reminders fall due: claim them, hand
  // each off right before its send, and settle it as sent. Returns what
  // it would have delivered.
  deliverDue(personId: string): { id: string; text: string; generation: number }[] {
    const { sql } = this.person(personId);
    const token = crypto.randomUUID();
    const sent: { id: string; text: string; generation: number }[] = [];
    for (const r of claimDueReminders(sql, this.now(), 120_000, token, 25)) {
      if (!handOffReminder(sql, r.id, token, this.now())) continue;
      finishReminder(sql, r.id, token, { kind: "sent" }, this.now());
      sent.push({ id: r.id, text: r.text, generation: r.generation });
    }
    return sent;
  }

  approvals() {
    return [...this.persons.values()].flatMap((p) =>
      (p.sql.exec("SELECT id FROM approvals ORDER BY created_at").toArray() as { id: string }[]).map((r) => p.store.getApproval(r.id)!),
    );
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
      MANO_ENGINE_CHANNELS_TOKEN: ENGINE_CHANNELS_TOKEN,
      MANO_HANDLE_GRANT_SECRET: GRANT_SECRET,
    });
    if (!caller || caller.personId !== personId || !serviceMayUse(caller.service, method, rest)) {
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const { sql, store, gateway } = this.person(personId);
    const nowIso = () => new Date(this.now()).toISOString();
    try {
      if (rest === "/memory" && method === "GET") {
        return Response.json({ memories: sql.exec("SELECT * FROM memory ORDER BY created_at").toArray() });
      }
      if (rest === "/memory" && method === "POST") {
        if (!isGeneration(body.generation)) return Response.json({ error: "generation is required." }, { status: 400 });
        const id = crypto.randomUUID();
        const written = sql.exec(
          `INSERT INTO memory(id, content, source, created_at, generation) SELECT ?, ?, ?, ?, ? WHERE ${CURRENT_GENERATION} = ?`,
          id, body.content, body.source, nowIso(), body.generation, body.generation,
        ).rowsWritten;
        return written > 0 ? Response.json({ id }) : Response.json(STALE, { status: 409 });
      }
      const memoryMatch = rest.match(/^\/memory\/([^/]+)$/);
      if (memoryMatch && method === "DELETE") {
        const id = decodeURIComponent(memoryMatch[1]);
        sql.exec("DELETE FROM memory WHERE id = ?", id);
        return Response.json({ id, forgotten: true });
      }
      if (rest === "/approvals" && method === "GET") {
        const approvals = (sql.exec("SELECT id FROM approvals ORDER BY created_at DESC").toArray() as { id: string }[]).map((r) => {
          const approval = store.getApproval(r.id)!;
          const attempt = store.getAttempt(approval.idempotencyKey);
          const receipt = store.getReceiptByKey(approval.idempotencyKey);
          return {
            ...approval,
            outcome: {
              attempt: attempt?.status ?? null,
              receipt: receipt ? { externalId: receipt.externalId, simulated: receipt.simulated } : null,
            },
          };
        });
        return Response.json({ approvals });
      }
      if (rest === "/action" && method === "POST") {
        if (!isGeneration(body.generation)) return Response.json({ error: "generation is required." }, { status: 400 });
        const { generation, ...action } = body;
        // As Engine: a draft names its turn, ordered from the turn ledger.
        const split = splitProposalTurn(action);
        if (!split) return Response.json({ status: "blocked", reason: "proposalTurn must name a turn." });
        const proposal = split.turnId === null ? undefined : (proposalOrderFor(sql, split.turnId) ?? undefined);
        if (split.turnId !== null && !proposal) return Response.json({ status: "blocked", reason: "Unknown turn." });
        return Response.json(
          await gateway.requestAction({ ...(split.request as object), personId }, new Date(this.now()), { generation, proposal }),
        );
      }
      if (rest === "/approvals/supersede" && method === "POST") {
        if (!isGeneration(body.generation)) return Response.json({ error: "generation is required." }, { status: 400 });
        if (body.generation !== currentGeneration(sql)) return Response.json(STALE, { status: 409 });
        return Response.json({ closed: store.rejectSupersededProposals(body.generation) });
      }
      const decision = rest.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
      if (decision && method === "POST") {
        const id = decodeURIComponent(decision[1]);
        return Response.json(decision[2] === "approve" ? await gateway.approveAndExecute(id, personId) : await gateway.rejectApproval(id, personId));
      }
      if (rest === "/reminders" && method === "POST") {
        const out = createReminder(sql, parseReminderInput(body), this.now());
        if ("stale" in out) return Response.json(STALE, { status: 409 });
        if ("conflict" in out) return Response.json({ status: "conflict", reminder: out.conflict }, { status: 409 });
        return Response.json({ status: out.created ? "created" : "existing", reminder: out.reminder }, { status: out.created ? 201 : 200 });
      }
      if (rest === "/reminders" && method === "GET") return Response.json({ reminders: listReminders(sql) });
      const cancelMatch = rest.match(/^\/reminders\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        const out = cancelReminder(sql, decodeURIComponent(cancelMatch[1]), this.now());
        if (!out.reminder) return Response.json({ error: "Reminder not found." }, { status: 404 });
        return Response.json(out);
      }
      if (rest === "/turns" && method === "POST") {
        const input = parseTurnInput(body);
        const out = putTurnIfAbsent(sql, input.turnId, input.receivedAt, input.generation);
        if ("stale" in out) return Response.json(STALE, { status: 409 });
        return Response.json(out, { status: out.created ? 201 : 200 });
      }
      const turnGet = rest.match(/^\/turns\/([^/]+)$/);
      if (turnGet && method === "GET") {
        const turn = getTurn(sql, decodeURIComponent(turnGet[1]));
        return turn ? Response.json({ turn }) : Response.json({ error: "Turn not found." }, { status: 404 });
      }
      const complete = rest.match(/^\/turns\/([^/]+)\/complete$/);
      if (complete && method === "POST") {
        const turn = completeTurn(sql, decodeURIComponent(complete[1]), nowIso(), parseGenerationInput(body).generation);
        if (turn && "stale" in turn) return Response.json(STALE, { status: 409 });
        if (!turn) return Response.json({ error: "Turn not found." }, { status: 404 });
        return Response.json({ turn });
      }
      if (rest === "/pending-approval" && method === "PUT") {
        const input = parsePointerInput(body);
        const set = setPendingPointer(sql, input.approvalId, input.generation, nowIso());
        return set ? Response.json(set) : Response.json({ error: "Approval not found." }, { status: 404 });
      }
      if (rest === "/pending-approval" && method === "GET") {
        const generation = Number(url.searchParams.get("generation"));
        return Response.json({
          pointer: getPendingPointer(sql, generation),
          latest: generation === currentGeneration(sql) ? store.latestProposal() : null,
        });
      }
      if (rest === "/pending-approval" && method === "DELETE") {
        const input = parsePointerInput(body);
        return Response.json({ cleared: clearPendingPointer(sql, input.approvalId, input.generation) });
      }
      const documentGet = rest.match(/^\/documents\/([^/]+)$/);
      if (documentGet && method === "GET") {
        const bytes = this.documents.get(`${personId}/${decodeURIComponent(documentGet[1])}`);
        return bytes ? new Response(bytes as BodyInit, { headers: { "content-type": "application/octet-stream" } }) : Response.json({ error: "Document not found." }, { status: 404 });
      }
      if (rest === "/deadlines" && method === "POST") {
        if (!this.deadlinesLive) return new Response("Not found", { status: 404 });
        this.deadlineCalls.push({ personId, body });
        return Response.json({ deadline: { id: String(body.idempotencyKey), ...body } }, { status: 201 });
      }
      if (rest === "/conversation" && method === "GET") return Response.json({ generation: currentGeneration(sql) });
      if (rest === "/conversation" && method === "DELETE") {
        return Response.json({ removed: removeConversationState(sql, this.now(), parseGenerationInput(body).generation) });
      }
    } catch (err) {
      if (err instanceof AgentStateInputError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
    return new Response("Not found", { status: 404 });
  };
}
