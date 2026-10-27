import { DurableObject } from "cloudflare:workers";
import {
  signMessage,
  type ConsentGrantPayload,
  type ConsentRevokePayload,
} from "@mano/protocol";
import type { Env } from "../env.js";
import { ActionGateway, InMemoryExecutor, MemoryApprovalStore } from "../gateway/index.js";
import type { ActionRequest } from "../gateway/index.js";
import { extractEvidence } from "../evidence.js";
import { sha256Hex } from "../hash.js";
import { generateAgentKeypair, importAgentPrivateKey } from "./agent-keys.js";
import { ConsentDeliveringExecutor } from "./person-executor.js";
import type { OrgAgent } from "./org-agent.js";

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

export interface GrantConsentInput {
  orgAgentId: string;
  purpose: string;
  scope: string[];
  caseId: string;
}

export interface RevokeConsentInput {
  orgAgentId: string;
  caseId: string;
}

const ORG_AGENT_ID = /^org:([A-Za-z0-9_-]+)$/;

export class PersonAgent extends DurableObject<Env> {
  private store = new MemoryApprovalStore();
  private gateway: ActionGateway;
  private keypair: { privateKey: CryptoKey; publicKeyB64: string } | null = null;
  personId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.gateway = new ActionGateway(
      this.store,
      new ConsentDeliveringExecutor(new InMemoryExecutor(), (req) => this.deliverShare(req)),
      { listConsents: () => this.listStoredConsents() },
    );
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS profile(id TEXT PRIMARY KEY, display_name TEXT, synthetic INTEGER NOT NULL DEFAULT 0, public_key_b64 TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS conversation(id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS deadlines(id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, r2_key TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, action_type TEXT, recipient TEXT, purpose TEXT, document_hash TEXT, document_id TEXT, idempotency_key TEXT, status TEXT, approved_by TEXT, created_at TEXT, remind_at TEXT, expires_at TEXT, escalated INTEGER, person_id TEXT, request_json TEXT, request_hash TEXT, problems_json TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS consents(recipient TEXT NOT NULL, purpose TEXT NOT NULL, PRIMARY KEY (recipient, purpose))`);
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

  private async assertSubject(verified: string) {
    if (!verified) throw new Error("Forbidden: no verified subject.");
    if (!this.personId) await this.setIdentity(verified);
    else if (this.personId !== verified) throw new Error("Forbidden: subject mismatch.");
  }

  async setIdentity(personId: string) {
    this.personId = personId;
    await this.ctx.storage.put("personId", personId);
    this.sql().exec("INSERT OR IGNORE INTO profile(id, display_name, synthetic) VALUES (?, ?, 0)", personId, personId);
    this.sql().exec("UPDATE profile SET display_name = ? WHERE id = ?", personId, personId);
  }

  private async ensureKeypair(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
    if (this.keypair) return this.keypair;
    const stored = await this.ctx.storage.get<JsonWebKey>("agentPrivateKeyJwk");
    if (stored) {
      const rows = this.sql().exec("SELECT public_key_b64 FROM profile WHERE id = ?", this.personId).toArray() as unknown as {
        public_key_b64: string | null;
      }[];
      const publicKeyB64 = rows[0]?.public_key_b64;
      if (publicKeyB64) {
        this.keypair = { privateKey: await importAgentPrivateKey(stored), publicKeyB64 };
        return this.keypair;
      }
    }
    const fresh = await generateAgentKeypair();
    await this.ctx.storage.put("agentPrivateKeyJwk", fresh.privateJwk);
    this.sql().exec("UPDATE profile SET public_key_b64 = ? WHERE id = ?", fresh.publicKeyB64, this.personId);
    this.keypair = { privateKey: await importAgentPrivateKey(fresh.privateJwk), publicKeyB64: fresh.publicKeyB64 };
    return this.keypair;
  }

  // Public key of this agent. Published so org agents can verify messages
  // from this stub; the binding of key to agent ID is the stub lookup.
  async getPublicKey(): Promise<string> {
    return (await this.ensureKeypair()).publicKeyB64;
  }

  private listStoredConsents(): { recipient: string; purpose: string }[] {
    const rows = this.sql().exec("SELECT recipient, purpose FROM consents").toArray() as unknown as {
      recipient: string;
      purpose: string;
    }[];
    return rows.map((r) => ({ recipient: r.recipient, purpose: r.purpose }));
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

  async requestAction(raw: unknown, verified: string) {
    await this.assertSubject(verified);
    const result = await this.gateway.requestAction(raw);
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
    this.audit("gateway.request", { status: result.status });
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

  async approve(approvalId: string, verified: string) {
    await this.assertSubject(verified);
    // Pre-stamp who is approving so the share delivery running inside the
    // gateway can read it from the same row, then reconcile the row from
    // the gateway afterward so a blocked approval never keeps the stamp.
    this.sql().exec("UPDATE approvals SET approved_by = ? WHERE id = ?", verified, approvalId);
    const result = await this.gateway.approveAndExecute(approvalId, verified);
    const current = this.store.getApproval(approvalId);
    if (current) {
      this.sql().exec(
        "UPDATE approvals SET status = ?, approved_by = ?, problems_json = ? WHERE id = ?",
        current.status, current.approvedByHumanId, JSON.stringify(current.problems), current.id,
      );
    }
    if (result.receipt) this.persistReceipt(result.receipt);
    if ((result.status === "completed" || result.status === "reconciled") && current?.actionType === "share") {
      this.recordConsentOutcome(current);
    }
    this.audit("gateway.approve", { approvalId, status: result.status });
    return result;
  }

  private recordConsentOutcome(approval: { recipient: string; purpose: string; requestJson: string }) {
    try {
      const stored = JSON.parse(approval.requestJson) as { payload?: { consent?: string } };
      if (stored.payload?.consent === "grant") {
        this.sql().exec("INSERT OR REPLACE INTO consents VALUES (?, ?)", approval.recipient, approval.purpose);
      } else if (stored.payload?.consent === "revoke") {
        this.sql().exec("DELETE FROM consents WHERE recipient = ? AND purpose = ?", approval.recipient, approval.purpose);
      }
    } catch {
      // Approval JSON is written by the gateway; ignore unreadable rows.
    }
  }

  async grantConsent(verified: string, input: GrantConsentInput) {
    await this.assertSubject(verified);
    const orgAgentId = requireOrgAgentId(input.orgAgentId);
    if (!input.purpose || !input.caseId) throw new Error("Consent needs a purpose and a case ID.");
    if (!Array.isArray(input.scope)) throw new Error("Consent needs a scope list.");
    const req: ActionRequest = {
      type: "share",
      recipient: orgAgentId,
      purpose: input.purpose,
      payload: { consent: "grant", caseId: input.caseId, scope: input.scope },
      idempotencyKey: `consent-grant-${input.caseId}-${crypto.randomUUID()}`,
      actor: "foreground",
      personId: this.personId,
      sources: [{ kind: "profile", id: this.personId }],
      origin: "person",
    };
    return this.requestAction(req, verified);
  }

  async revokeConsent(verified: string, input: RevokeConsentInput) {
    await this.assertSubject(verified);
    const orgAgentId = requireOrgAgentId(input.orgAgentId);
    if (!input.caseId) throw new Error("Revocation needs a case ID.");
    const req: ActionRequest = {
      type: "share",
      recipient: orgAgentId,
      purpose: "revoke access",
      payload: { consent: "revoke", caseId: input.caseId },
      idempotencyKey: `consent-revoke-${input.caseId}-${crypto.randomUUID()}`,
      actor: "foreground",
      personId: this.personId,
      sources: [{ kind: "profile", id: this.personId }],
      origin: "person",
    };
    return this.requestAction(req, verified);
  }

  // Delivers an approved share action as a signed consent message. Runs
  // inside the gateway executor, so the human approval on the row is the
  // one the gateway just consumed.
  private async deliverShare(req: ActionRequest): Promise<{ externalId: string }> {
    const match = ORG_AGENT_ID.exec(req.recipient);
    if (!match) throw new Error(`Share recipient must be an org agent ID, got ${req.recipient}.`);
    const consent = req.payload.consent;
    if (consent !== "grant" && consent !== "revoke") {
      throw new Error("Share payload must declare a grant or revoke.");
    }
    const caseId = req.payload.caseId;
    if (typeof caseId !== "string" || !caseId) throw new Error("Share payload must carry a case ID.");
    const rows = this.sql().exec(
      "SELECT approved_by FROM approvals WHERE idempotency_key = ?",
      req.idempotencyKey,
    ).toArray() as unknown as { approved_by: string | null }[];
    const approvedByHumanId = rows[0]?.approved_by ?? null;
    if (!approvedByHumanId) throw new Error("No recorded human approval for this share.");
    const scope = Array.isArray(req.payload.scope)
      ? req.payload.scope.filter((s): s is string => typeof s === "string")
      : [];
    const payload: ConsentGrantPayload | ConsentRevokePayload =
      consent === "grant"
        ? { orgAgentId: req.recipient, purpose: req.purpose, scope }
        : { orgAgentId: req.recipient };
    const keys = await this.ensureKeypair();
    const message = await signMessage(
      {
        id: crypto.randomUUID(),
        type: consent === "grant" ? "consent.grant" : "consent.revoke",
        caseId,
        fromAgentId: `person:${this.personId}`,
        toAgentId: req.recipient,
        payload,
        sources: [{ kind: "profile", id: this.personId }],
        approvedByHumanId,
        idempotencyKey: req.idempotencyKey,
        createdAt: new Date().toISOString(),
      },
      keys.privateKey,
      keys.publicKeyB64,
    );
    const stub = this.env.ORG_AGENT.get(this.env.ORG_AGENT.idFromName(match[1]));
    const result = await (stub as unknown as OrgAgent).receiveConsent(message);
    if (!result.accepted) throw new Error(result.reason ?? "The org rejected the consent message.");
    return { externalId: message.id };
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
      return Response.json(await this.requestAction(body, subject));
    }
    return new Response("Not found", { status: 404 });
  }
}

function requireOrgAgentId(value: string): string {
  if (typeof value !== "string" || !ORG_AGENT_ID.test(value)) {
    throw new Error("orgAgentId must look like org:<id>.");
  }
  return value;
}
