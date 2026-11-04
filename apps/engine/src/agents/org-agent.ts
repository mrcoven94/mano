import { Agent } from "agents";
import {
  PROTOCOL_VERSION,
  signMessage,
  validateMessageShape,
  verifyMessage,
  type DocumentRequestPayload,
  type MessageType,
  type ProtocolMessage,
} from "@mano/protocol";
import type { Env } from "../env.js";
import { CASE_ID_RULE, isCaseId } from "../case-id.js";
import { auditDigest, type AuditEntry } from "../gateway/audit.js";
import { generateAgentKeypair, importAgentPrivateKey, resolveAgentKey } from "./agent-keys.js";
import { DOCUMENT_KINDS, documentKindLabel } from "../case-sharing.js";
import type { PersonAgent } from "./person-agent.js";
import {
  applyConsentDelivery,
  consentEventRecorded,
  senderPerson,
  type ConsentEventType,
  type DeliveryScope,
} from "../consent-dedupe.js";

export interface SharedCase {
  caseId: string;
  personId: string;
  purpose: string;
  sharedAt: string;
}

export interface ConsentResult {
  accepted: boolean;
  reason?: string;
  duplicate?: boolean;
  // True when the rejection is transient (storage unavailable): the
  // sender must reconcile, never treat it as a definite refusal.
  retryable?: boolean;
}

// What staff see of one active case: only what the person shared and what
// they sent in answer to a request. Never the person's agent ID.
export interface CaseView {
  caseId: string;
  purpose: string;
  sharedAt: string;
  details: { label: string; value: string }[];
  requests: { id: string; documentKind: string; label: string; status: string; requestedAt: string }[];
  documents: { id: string; name: string; label: string; providedAt: string }[];
  requestableKinds: Record<string, string>;
}

export type DocumentRequestResult =
  | { status: "requested"; requestId: string }
  // Not shared with this org, or no longer: nothing was asked.
  | { status: "not_shared" }
  | { status: "bad_input"; reason: string }
  // The person's agent did not answer: the same key can be sent again.
  | { status: "unavailable" };

const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;

// Synced to staff screens: the org's active shared cases.
export interface OrgState {
  orgId: string;
  cases: SharedCase[];
}

const ORG_AGENT_ID = /^org:([A-Za-z0-9_-]+)$/;

export class OrgAgent extends Agent<Env, OrgState> {
  initialState: OrgState = { orgId: "", cases: [] };
  orgId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      // Append-only history: revocation is terminal and is never
      // overwritten by a later share of the same case.
      sql.exec(`CREATE TABLE IF NOT EXISTS case_events(id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, event TEXT NOT NULL, person_id TEXT NOT NULL, purpose TEXT NOT NULL, message_id TEXT NOT NULL, at TEXT NOT NULL)`);
      // The delivery key behind each event: reconcile reads the event
      // record, and retries find the event their key already applied.
      try {
        sql.exec(`ALTER TABLE case_events ADD COLUMN idempotency_key TEXT`);
      } catch {
        // The column already exists: additive migrations are idempotent.
      }
      // The values the person's approval froze, carried by the grant.
      try {
        sql.exec(`ALTER TABLE case_events ADD COLUMN details_json TEXT`);
      } catch {
        // The column already exists: additive migrations are idempotent.
      }
      // What staff asked for, with the signed message resent on a retry,
      // and what the person sent. The bytes stay with the person's agent.
      sql.exec(`CREATE TABLE IF NOT EXISTS document_requests(id TEXT PRIMARY KEY, case_id TEXT NOT NULL, document_kind TEXT NOT NULL, status TEXT NOT NULL, message_json TEXT NOT NULL, requested_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS shared_documents(document_id TEXT NOT NULL, case_id TEXT NOT NULL, name TEXT NOT NULL, document_kind TEXT NOT NULL, provided_at TEXT NOT NULL, PRIMARY KEY (case_id, document_id))`);
      sql.exec(`CREATE TABLE IF NOT EXISTS agent_keys(agent_id TEXT PRIMARY KEY, public_key_b64 TEXT NOT NULL, first_seen TEXT NOT NULL)`);
      // Dedupe on sender plus idempotency key: retries resend the same
      // key, so a duplicate revoke can never end a newer share.
      const processedCols = sql.exec(`PRAGMA table_info(processed_messages)`).toArray() as unknown as {
        name: string;
      }[];
      if (processedCols.length > 0 && !processedCols.some((c) => c.name === "sender_agent_id")) {
        sql.exec(`DROP TABLE processed_messages`);
      }
      sql.exec(`CREATE TABLE IF NOT EXISTS processed_messages(sender_agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY (sender_agent_id, idempotency_key))`);
      // Each case is bound to the resident who first shared it. Only that
      // resident's later messages can change it.
      sql.exec(`CREATE TABLE IF NOT EXISTS case_owners(case_id TEXT PRIMARY KEY, person_id TEXT NOT NULL)`);
      try {
        sql.exec(`ALTER TABLE case_owners ADD COLUMN expires_at TEXT`);
      } catch {
        // The column already exists: additive migrations are idempotent.
      }
      // Expiry is stored as epoch milliseconds and compared numerically.
      // The legacy ISO text column compared lexically, which breaks on
      // non-UTC offsets; its surviving values are parsed once here.
      try {
        sql.exec(`ALTER TABLE case_owners ADD COLUMN expires_at_ms INTEGER`);
      } catch {
        // The column already exists: additive migrations are idempotent.
      }
      const legacyExpiry = sql.exec(
        `SELECT case_id, expires_at FROM case_owners WHERE expires_at_ms IS NULL AND expires_at IS NOT NULL`,
      ).toArray() as unknown as { case_id: string; expires_at: string }[];
      for (const row of legacyExpiry) {
        const ms = new Date(row.expires_at).getTime();
        sql.exec(`UPDATE case_owners SET expires_at_ms = ? WHERE case_id = ?`, Number.isFinite(ms) ? ms : null, row.case_id);
      }
      sql.exec(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, detail TEXT, created_at TEXT)`);
      const stored = await ctx.storage.get<string>("orgId");
      if (stored) this.orgId = stored;
      // The keypair is created here, inside blockConcurrencyWhile, so two
      // first calls can never generate two different keys.
      const existingKey = await ctx.storage.get<string>("agentPublicKeyB64");
      if (!existingKey) {
        const fresh = await generateAgentKeypair();
        await ctx.storage.put("agentPrivateKeyJwk", fresh.privateJwk);
        await ctx.storage.put("agentPublicKeyB64", fresh.publicKeyB64);
      }
    });
  }

  private db() {
    return this.ctx.storage.sql;
  }

  private audit<const T extends { event: string }>(entry: T & AuditEntry<T>) {
    this.db().exec(
      "INSERT INTO audit_log(event, detail, created_at) VALUES (?, ?, ?)",
      entry.event,
      JSON.stringify(entry),
      new Date().toISOString(),
    );
  }

  private async assertOrg(verifiedOrg: string) {
    if (!verifiedOrg) throw new Error("Forbidden: no verified org.");
    if (!this.orgId) {
      this.orgId = verifiedOrg;
      await this.ctx.storage.put("orgId", verifiedOrg);
      this.syncState();
    } else if (this.orgId !== verifiedOrg) {
      throw new Error("Forbidden: org mismatch.");
    }
  }

  private syncState(): void {
    this.setState({ orgId: this.orgId, cases: this.activeCases() });
  }

  // Public key of this agent, for org-signed messages. Created once in
  // the constructor; this read never generates, so concurrent first calls
  // cannot diverge.
  async getPublicKey(): Promise<string> {
    const stored = await this.ctx.storage.get<string>("agentPublicKeyB64");
    if (!stored) throw new Error("Agent keypair is missing.");
    return stored;
  }

  // Accepts a signed consent message delivered by a person's agent. Only
  // this path adds cases to the org; the worker exposes no share route.
  async receiveConsent(message: unknown): Promise<ConsentResult> {
    const inbound = await this.verifiedInbound(message, ["consent.grant", "consent.revoke"]);
    if ("refused" in inbound) return inbound.refused;
    const { msg, payload } = inbound;
    const sender = senderPerson(msg.fromAgentId);
    const owner = this.caseOwner(msg.caseId, msg.type === "consent.grant" ? sender : null);
    if (owner !== sender) {
      return { accepted: false, reason: "Only the resident who shared this case can change it." };
    }
    const now = new Date().toISOString();
    if (msg.type === "consent.revoke") {
      const scope: DeliveryScope = { fromAgentId: msg.fromAgentId, idempotencyKey: msg.idempotencyKey, event: "revoke" };
      const delivery = this.applyDelivery(scope, () => {
        this.appendEvent(msg.caseId, "revoke", sender, "", msg.id, now, msg.idempotencyKey);
      });
      if (delivery === "duplicate") return { accepted: true, duplicate: true };
      if (delivery === "unavailable") return { accepted: false, reason: "The org cannot record this delivery right now. Retry.", retryable: true };
      this.audit({
        event: "consent.revoke",
        caseHash: await auditDigest(msg.caseId),
        fromHash: await auditDigest(msg.fromAgentId),
      });
      this.syncState();
      return { accepted: true };
    }
    if (typeof payload.purpose !== "string" || !payload.purpose) {
      return { accepted: false, reason: "Consent grant needs a purpose." };
    }
    const expiresAt = payload.expiresAt;
    let expiresAtMs: number | null = null;
    if (expiresAt !== undefined) {
      if (typeof expiresAt !== "string" || !Number.isFinite(new Date(expiresAt).getTime())) {
        return { accepted: false, reason: "Consent grant carries an invalid expiry." };
      }
      expiresAtMs = new Date(expiresAt).getTime();
      if (expiresAtMs <= Date.now()) {
        return { accepted: false, reason: `Case ${msg.caseId} consent already expired.` };
      }
    }
    const revoked = this.db().exec(
      "SELECT id FROM case_events WHERE case_id = ? AND event = 'revoke'",
      msg.caseId,
    ).toArray();
    if (revoked.length > 0) {
      return { accepted: false, reason: `Case ${msg.caseId} was revoked and cannot be shared again.` };
    }
    const scope: DeliveryScope = { fromAgentId: msg.fromAgentId, idempotencyKey: msg.idempotencyKey, event: "share" };
    const delivery = this.applyDelivery(scope, () => {
      this.db().exec("UPDATE case_owners SET expires_at_ms = ? WHERE case_id = ?", expiresAtMs, msg.caseId);
      this.appendEvent(msg.caseId, "share", sender, payload.purpose as string, msg.id, now, msg.idempotencyKey, JSON.stringify(payload.details ?? []));
    });
    if (delivery === "duplicate") return { accepted: true, duplicate: true };
    if (delivery === "unavailable") return { accepted: false, reason: "The org cannot record this delivery right now. Retry.", retryable: true };
    this.audit({
      event: "consent.grant",
      caseHash: await auditDigest(msg.caseId),
      fromHash: await auditDigest(msg.fromAgentId),
    });
    this.syncState();
    return { accepted: true };
  }

  // A document the person approved sending, in answer to a request this
  // org made on a case still shared with it. Only the record comes here.
  async receiveDocument(message: unknown): Promise<ConsentResult> {
    const inbound = await this.verifiedInbound(message, ["document.provide"]);
    if ("refused" in inbound) return inbound.refused;
    const { msg, payload } = inbound;
    const sender = senderPerson(msg.fromAgentId);
    if (this.activeCase(msg.caseId)?.personId !== sender) {
      return { accepted: false, reason: "This case is not shared with this org." };
    }
    const { documentId, requestId, documentKind, name } = payload;
    const request = this.db().exec("SELECT id FROM document_requests WHERE id = ? AND case_id = ?", String(requestId), msg.caseId).toArray();
    if (typeof documentId !== "string" || request.length === 0 || !documentKindLabel(documentKind)) {
      return { accepted: false, reason: "This org did not ask for that document." };
    }
    const now = new Date().toISOString();
    const scope: DeliveryScope = { fromAgentId: msg.fromAgentId, idempotencyKey: msg.idempotencyKey, event: "document" };
    const delivery = this.applyDelivery(scope, () => {
      this.db().exec(
        "INSERT OR IGNORE INTO shared_documents(document_id, case_id, name, document_kind, provided_at) VALUES (?, ?, ?, ?, ?)",
        documentId, msg.caseId, typeof name === "string" && name ? name : documentId, documentKind as string, now,
      );
      this.db().exec("UPDATE document_requests SET status = 'provided' WHERE id = ? AND case_id = ?", String(requestId), msg.caseId);
      this.appendEvent(msg.caseId, "document", sender, "", msg.id, now, msg.idempotencyKey);
    });
    if (delivery === "duplicate") return { accepted: true, duplicate: true };
    if (delivery === "unavailable") return { accepted: false, reason: "The org cannot record this delivery right now. Retry.", retryable: true };
    this.audit({ event: "case.document_received", caseHash: await auditDigest(msg.caseId), fromHash: await auditDigest(msg.fromAgentId) });
    return { accepted: true };
  }

  // Checks common to everything a person's agent delivers: shape, address,
  // the human approval, the case ID, and a signature against the sender's
  // own key. Pins the org ID once a signature verifies.
  private async verifiedInbound(
    message: unknown,
    types: readonly MessageType[],
  ): Promise<{ msg: ProtocolMessage; payload: Record<string, unknown> } | { refused: ConsentResult }> {
    const refused = (reason: string) => ({ refused: { accepted: false, reason } });
    if (!validateMessageShape(message)) {
      return refused("Malformed consent message.");
    }
    const msg = message as ProtocolMessage;
    if (!types.includes(msg.type)) {
      return refused(`Wrong message type: ${msg.type}.`);
    }
    const addressed = ORG_AGENT_ID.exec(msg.toAgentId);
    if (!addressed) {
      return refused("This message is not addressed to an org agent.");
    }
    // A pinned ID rejects anything else, but pinning waits until a
    // signature verifies below: an unverified message never sets it.
    if (this.orgId && this.orgId !== addressed[1]) {
      return refused("This message is addressed to a different org.");
    }
    if (!msg.approvedByHumanId) {
      return refused("Consent needs a person's approval.");
    }
    if (!isCaseId(msg.caseId)) {
      return refused(CASE_ID_RULE);
    }
    const expected = await this.keyForSender(msg.fromAgentId);
    if (!expected) {
      return refused(`Unknown sender: ${msg.fromAgentId}.`);
    }
    if (!(await verifyMessage(msg, expected))) {
      return refused("Bad consent signature.");
    }
    if (!this.orgId) {
      this.orgId = addressed[1];
      await this.ctx.storage.put("orgId", this.orgId);
    }
    const payload = msg.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return refused("Consent payload must be an object.");
    }
    return { msg, payload: payload as Record<string, unknown> };
  }

  // The resident a case is bound to. A grant binds an unbound case to its
  // sender; every later message must come from that same resident.
  private caseOwner(caseId: string, bindTo: string | null): string | null {
    if (bindTo) {
      this.db().exec("INSERT OR IGNORE INTO case_owners(case_id, person_id) VALUES (?, ?)", caseId, bindTo);
    }
    const rows = this.db().exec("SELECT person_id FROM case_owners WHERE case_id = ?", caseId).toArray() as unknown as {
      person_id: string;
    }[];
    return rows[0]?.person_id ?? null;
  }

  // Marker plus event in one Durable Object transaction. SQL BEGIN
  // is forbidden here; transactionSync rolls back on throw.
  private applyDelivery(scope: DeliveryScope, append: () => void) {
    return applyConsentDelivery(this.db(), scope, append, (fn) => this.ctx.storage.transactionSync(fn));
  }

  // Whether this org recorded this sender's event of this type under a
  // delivery key. The person's agent asks this to reconcile a share;
  // agent-to-agent only. The sender and the type are part of the match:
  // keys are caller-controlled, so another sender's event (or a grant
  // where a revoke was asked) must never satisfy this reconcile. A pure
  // historical fact: expiry is enforced on case reads, not by rewriting
  // delivery history.
  async hasConsentRecord(fromAgentId: string, idempotencyKey: string, event: ConsentEventType): Promise<boolean> {
    return consentEventRecorded(this.db(), { fromAgentId, idempotencyKey, event });
  }

  private async keyForSender(fromAgentId: string): Promise<string | null> {
    const rows = this.db().exec(
      "SELECT public_key_b64 FROM agent_keys WHERE agent_id = ?",
      fromAgentId,
    ).toArray() as unknown as { public_key_b64: string }[];
    if (rows[0]?.public_key_b64) return rows[0].public_key_b64;
    // Not cached: resolve live from the sender's own agent stub, which no
    // caller can forge, then pin the key.
    const resolved = await resolveAgentKey(this.env, fromAgentId);
    if (!resolved) return null;
    this.db().exec(
      "INSERT OR IGNORE INTO agent_keys VALUES (?, ?, ?)",
      fromAgentId,
      resolved,
      new Date().toISOString(),
    );
    return resolved;
  }

  private appendEvent(
    caseId: string,
    event: ConsentEventType,
    personId: string,
    purpose: string,
    messageId: string,
    at: string,
    idempotencyKey: string,
    detailsJson: string | null = null,
  ) {
    this.db().exec(
      "INSERT INTO case_events(case_id, event, person_id, purpose, message_id, at, idempotency_key, details_json) VALUES (?,?,?,?,?,?,?,?)",
      caseId, event, personId, purpose, messageId, at, idempotencyKey, detailsJson,
    );
  }

  async listCases(verifiedOrg: string): Promise<SharedCase[]> {
    await this.assertOrg(verifiedOrg);
    return this.activeCases();
  }

  // One active case for staff, or null when it is not shared with this
  // org: never shared, revoked and expired all read the same.
  async getCase(verifiedOrg: string, caseId: string): Promise<CaseView | null> {
    await this.assertOrg(verifiedOrg);
    const before = this.activeCase(caseId);
    if (!before) return null;
    // Only what the person's agent says can still be opened: a delete ends
    // the documents here too. An agent that does not answer shows none.
    const person = this.env.PERSON_AGENT.get(this.env.PERSON_AGENT.idFromName(before.personId)) as unknown as PersonAgent;
    const readable = new Set(await person.readableDocumentIds(`org:${this.orgId}`, caseId).catch(() => [] as string[]));
    // A revoke can land during that wait. Everything staff see is read from
    // here on, with no wait before it leaves.
    const active = this.activeCase(caseId);
    if (!active) return null;
    const share = this.db().exec(
      "SELECT details_json FROM case_events WHERE case_id = ? AND event = 'share' ORDER BY id DESC LIMIT 1",
      caseId,
    ).toArray()[0] as { details_json: string | null } | undefined;
    const requests = this.db().exec(
      "SELECT id, document_kind, status, requested_at FROM document_requests WHERE case_id = ? ORDER BY requested_at",
      caseId,
    ).toArray() as unknown as { id: string; document_kind: string; status: string; requested_at: string }[];
    const documents = (this.db().exec(
      "SELECT document_id, name, document_kind, provided_at FROM shared_documents WHERE case_id = ? ORDER BY provided_at",
      caseId,
    ).toArray() as unknown as { document_id: string; name: string; document_kind: string; provided_at: string }[]).filter((d) => readable.has(d.document_id));
    return {
      caseId: active.caseId,
      purpose: active.purpose,
      sharedAt: active.sharedAt,
      details: JSON.parse(share?.details_json ?? "[]") as { label: string; value: string }[],
      requests: requests.map((r) => ({ id: r.id, documentKind: r.document_kind, label: documentKindLabel(r.document_kind) ?? r.document_kind, status: r.status, requestedAt: r.requested_at })),
      documents: documents.map((d) => ({ id: d.document_id, name: d.name, label: documentKindLabel(d.document_kind) ?? d.document_kind, providedAt: d.provided_at })),
      requestableKinds: DOCUMENT_KINDS,
    };
  }

  // Staff ask the person for a document. The signed request is stored
  // before it goes, so a retry under the same key resends the same message
  // and the person is texted once.
  async requestDocument(verifiedOrg: string, caseId: string, input: { documentKind: unknown; idempotencyKey: unknown }): Promise<DocumentRequestResult> {
    await this.assertOrg(verifiedOrg);
    const { documentKind, idempotencyKey } = input;
    if (typeof documentKind !== "string" || !documentKindLabel(documentKind)) return { status: "bad_input", reason: "Unknown document kind." };
    if (typeof idempotencyKey !== "string" || !REQUEST_KEY.test(idempotencyKey)) return { status: "bad_input", reason: "A request needs an idempotency key." };
    const active = this.activeCase(caseId);
    if (!active) return { status: "not_shared" };
    // A key names one request across this org, since the person's agent
    // knows a request by org and key. Signing awaits, so another request
    // under the key can store first: only the stored message is delivered,
    // and only to the caller that asked for exactly it.
    const storedRequest = () =>
      this.db().exec("SELECT case_id, document_kind, message_json FROM document_requests WHERE id = ?", idempotencyKey).toArray()[0] as
        | { case_id: string; document_kind: string; message_json: string }
        | undefined;
    if (!storedRequest()) {
      const signed = await this.signDocumentRequest(active, documentKind, idempotencyKey);
      this.db().exec(
        "INSERT OR IGNORE INTO document_requests(id, case_id, document_kind, status, message_json, requested_at) VALUES (?, ?, ?, 'open', ?, ?)",
        idempotencyKey, caseId, documentKind, JSON.stringify(signed), signed.createdAt,
      );
    }
    const stored = storedRequest();
    if (stored?.case_id !== caseId || stored.document_kind !== documentKind) {
      return { status: "bad_input", reason: "That idempotency key was used for another request." };
    }
    const message = JSON.parse(stored.message_json) as ProtocolMessage;
    const person = this.env.PERSON_AGENT.get(this.env.PERSON_AGENT.idFromName(active.personId)) as unknown as PersonAgent;
    let answer: { accepted: boolean };
    try {
      answer = await person.receiveDocumentRequest(message);
    } catch {
      return { status: "unavailable" };
    }
    if (!answer.accepted) {
      this.db().exec("UPDATE document_requests SET status = 'refused' WHERE id = ? AND status = 'open'", idempotencyKey);
      return { status: "not_shared" };
    }
    this.audit({ event: "case.document_request", caseHash: await auditDigest(caseId) });
    return { status: "requested", requestId: idempotencyKey };
  }

  private async signDocumentRequest(active: SharedCase, documentKind: string, idempotencyKey: string): Promise<ProtocolMessage> {
    const jwk = await this.ctx.storage.get<JsonWebKey>("agentPrivateKeyJwk");
    const publicKeyB64 = await this.getPublicKey();
    if (!jwk) throw new Error("Agent keypair is missing.");
    const payload: DocumentRequestPayload = { documentKind, reason: `Needed for ${active.purpose}.` };
    return signMessage(
      {
        id: crypto.randomUUID(),
        version: PROTOCOL_VERSION,
        type: "document.request",
        caseId: active.caseId,
        fromAgentId: `org:${this.orgId}`,
        toAgentId: `person:${active.personId}`,
        payload,
        sources: [],
        approvedByHumanId: null,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      },
      await importAgentPrivateKey(jwk),
      publicKeyB64,
    );
  }

  // A sent document's bytes for staff, asked of the person's agent on each
  // read: its own records must also say this org may read it.
  async readDocument(verifiedOrg: string, caseId: string, documentId: string): Promise<{ name: string; contentB64: string } | null> {
    await this.assertOrg(verifiedOrg);
    const active = this.activeCase(caseId);
    if (!active) return null;
    const row = this.db().exec("SELECT 1 FROM shared_documents WHERE case_id = ? AND document_id = ?", caseId, documentId).toArray();
    if (row.length === 0) return null;
    const person = this.env.PERSON_AGENT.get(this.env.PERSON_AGENT.idFromName(active.personId)) as unknown as PersonAgent;
    const document = await person.readSharedDocument(`org:${this.orgId}`, caseId, documentId);
    if (!document) return null;
    const caseHash = await auditDigest(caseId);
    // A revoke can land during those waits: the bytes stay here.
    if (!this.activeCase(caseId)) return null;
    this.audit({ event: "case.document_read", caseHash });
    return document;
  }

  private activeCase(caseId: string): SharedCase | null {
    return this.activeCases().find((c) => c.caseId === caseId) ?? null;
  }

  private activeCases(): SharedCase[] {
    const rows = this.db().exec(
      `SELECT e.case_id, e.person_id, e.purpose, MAX(e.at) AS shared_at FROM case_events e
       LEFT JOIN case_owners o ON o.case_id = e.case_id
       WHERE e.event = 'share' AND e.case_id NOT IN (SELECT case_id FROM case_events WHERE event = 'revoke')
       AND (o.expires_at_ms IS NULL OR o.expires_at_ms > ?)
       GROUP BY e.case_id ORDER BY shared_at`,
      Date.now(),
    ).toArray() as unknown as {
      case_id: string;
      person_id: string;
      purpose: string;
      shared_at: string;
    }[];
    return rows.map((r) => ({
      caseId: r.case_id,
      personId: r.person_id,
      purpose: r.purpose,
      sharedAt: r.shared_at,
    }));
  }
}
