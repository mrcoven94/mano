import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import { ActionGateway, InMemoryExecutor, MemoryApprovalStore } from "../gateway/index.js";
import type { ActionRequest } from "../gateway/index.js";
import { extractEvidence } from "../evidence.js";
import { sha256Hex } from "../hash.js";

interface ApprovalRow {
  id: string;
  action_type: string;
  recipient: string;
  purpose: string;
  document_hash: string | null;
  document_id: string | null;
  idempotency_key: string;
  status: string;
  approved_by: string | null;
  created_at: string;
  remind_at: string;
  expires_at: string;
  escalated: number;
  person_id: string;
  request_json: string;
  request_hash: string;
  problems_json: string;
}

export class PersonAgent extends DurableObject<Env> {
  private store = new MemoryApprovalStore();
  private executor = new InMemoryExecutor();
  private gateway = new ActionGateway(this.store, this.executor);
  personId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS profile(id TEXT PRIMARY KEY, display_name TEXT, synthetic INTEGER NOT NULL DEFAULT 1)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS conversation(id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS deadlines(id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, r2_key TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, action_type TEXT, recipient TEXT, purpose TEXT, document_hash TEXT, document_id TEXT, idempotency_key TEXT, status TEXT, approved_by TEXT, created_at TEXT, remind_at TEXT, expires_at TEXT, escalated INTEGER, person_id TEXT, request_json TEXT, request_hash TEXT, problems_json TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, detail TEXT, created_at TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, action_type TEXT, recipient TEXT, status TEXT, external_id TEXT, created_at TEXT)`);
      const stored = await ctx.storage.get<string>("personId");
      if (stored) this.personId = stored;
    });
  }

  private sql() {
    return this.ctx.storage.sql;
  }

  private audit(event: string, detail: unknown) {
    this.sql().exec(
      "INSERT INTO audit_log(event, detail, created_at) VALUES (?, ?, ?)",
      event,
      JSON.stringify(detail),
      new Date().toISOString(),
    );
  }

  async setIdentity(personId: string) {
    this.personId = personId;
    await this.ctx.storage.put("personId", personId);
    this.sql().exec(
      "INSERT OR REPLACE INTO profile(id, display_name, synthetic) VALUES (?, ?, 1)",
      personId,
      personId,
    );
  }

  async chat(message: string): Promise<{ reply: string; evidence?: ReturnType<typeof extractEvidence> }> {
    const id = crypto.randomUUID();
    this.sql().exec(
      "INSERT INTO conversation(id, role, content, created_at) VALUES (?, 'user', ?, ?)",
      id,
      message,
      new Date().toISOString(),
    );
    const ev = extractEvidence(message);
    const reply =
      ev.instructionsIgnored.length > 0
        ? "I read that as a document. I did not follow the instructions inside it. Tell me what you want me to do."
        : `Got it. I saved that to your conversation. You said: ${message.slice(0, 200)}`;
    this.sql().exec(
      "INSERT INTO conversation(id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
      crypto.randomUUID(),
      reply,
      new Date().toISOString(),
    );
    this.audit("chat", { instructionsIgnored: ev.instructionsIgnored.length });
    return { reply, evidence: ev };
  }

  async addMemory(content: string, source: string) {
    const id = crypto.randomUUID();
    this.sql().exec(
      "INSERT INTO memory(id, content, source, created_at) VALUES (?, ?, ?, ?)",
      id,
      content,
      source,
      new Date().toISOString(),
    );
    return id;
  }

  async listMemory() {
    return [...this.sql().exec("SELECT * FROM memory ORDER BY created_at").toArray()];
  }

  async requestAction(req: ActionRequest) {
    const result = await this.gateway.requestAction(req);
    if (result.approval) {
      const a = result.approval;
      this.sql().exec(
        "INSERT OR REPLACE INTO approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        a.id, a.actionType, a.recipient, a.purpose, a.documentHash, a.documentId,
        a.idempotencyKey, a.status, a.approvedByHumanId, a.createdAt, a.remindAt, a.expiresAt,
        a.escalated ? 1 : 0, a.personId, a.requestJson, a.requestHash, JSON.stringify(a.problems),
      );
    }
    if (result.receipt) this.persistReceipt(result.receipt);
    this.audit("gateway.request", { status: result.status, type: req.type });
    return result;
  }

  private persistReceipt(r: { id: string; idempotencyKey: string; actionType: string; recipient: string; status: string; externalId: string; createdAt: string }) {
    this.sql().exec(
      "INSERT OR REPLACE INTO receipts VALUES (?,?,?,?,?,?,?)",
      r.id, r.idempotencyKey, r.actionType, r.recipient, r.status, r.externalId, r.createdAt,
    );
  }

  async listApprovals() {
    const rows = [...this.sql().exec("SELECT * FROM approvals ORDER BY created_at DESC").toArray()] as unknown as ApprovalRow[];
    return rows.map((r) => ({
      id: r.id, actionType: r.action_type, recipient: r.recipient, purpose: r.purpose,
      documentHash: r.document_hash, documentId: r.document_id, idempotencyKey: r.idempotency_key,
      status: r.status, approvedByHumanId: r.approved_by, createdAt: r.created_at,
      remindAt: r.remind_at, expiresAt: r.expires_at, escalated: r.escalated === 1,
      personId: r.person_id, requestJson: r.request_json, requestHash: r.request_hash,
      problems: JSON.parse(r.problems_json ?? "[]") as string[],
    }));
  }

  async approve(approvalId: string, humanId: string) {
    const result = await this.gateway.approveAndExecute(approvalId, humanId);
    if (result.approval) {
      const a = result.approval;
      this.sql().exec("UPDATE approvals SET status = ?, approved_by = ? WHERE id = ?", a.status, a.approvedByHumanId, a.id);
    }
    if (result.receipt) this.persistReceipt(result.receipt);
    return result;
  }

  async registerDocument(name: string, content: string, r2Key: string) {
    const hash = await sha256Hex(content);
    const id = crypto.randomUUID();
    this.sql().exec("INSERT INTO documents VALUES (?,?,?,?)", id, name, hash, r2Key);
    return { id, hash };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The worker sets x-mano-subject from a verified session token and is
    // this agent's only caller. No other identity input is trusted.
    const subject = request.headers.get("x-mano-subject");
    if (!subject) return new Response("Forbidden", { status: 403 });
    if (!this.personId) await this.setIdentity(subject);
    else if (this.personId !== subject) return new Response("Forbidden", { status: 403 });
    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      server.addEventListener("message", async (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        const out = await this.chat(text);
        server.send(JSON.stringify({ type: "reply", ...out }));
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const body = (await request.json()) as { message: string };
      const out = await this.chat(body.message ?? "");
      return Response.json(out);
    }
    if (request.method === "GET" && url.pathname.endsWith("/approvals")) {
      return Response.json({ approvals: await this.listApprovals() });
    }
    if (request.method === "POST" && url.pathname.endsWith("/action")) {
      const body = (await request.json()) as ActionRequest;
      return Response.json(await this.requestAction(body));
    }
    return new Response("Not found", { status: 404 });
  }
}
