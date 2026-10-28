import { Agent } from "agents";
import {
  validateMessageShape,
  verifyMessage,
  type ProtocolMessage,
} from "@mano/protocol";
import type { Env } from "../env.js";
import { generateAgentKeypair, resolveAgentKey } from "./agent-keys.js";
import { applyConsentDelivery, consentEventRecorded } from "../consent-dedupe.js";

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

  private audit(event: string, detail: unknown) {
    this.db().exec(
      "INSERT INTO audit_log(event, detail, created_at) VALUES (?, ?, ?)",
      event,
      JSON.stringify(detail),
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
    if (!validateMessageShape(message)) {
      return { accepted: false, reason: "Malformed consent message." };
    }
    const msg = message as ProtocolMessage;
    if (msg.type !== "consent.grant" && msg.type !== "consent.revoke") {
      return { accepted: false, reason: `Wrong message type: ${msg.type}.` };
    }
    const addressed = ORG_AGENT_ID.exec(msg.toAgentId);
    if (!addressed) {
      return { accepted: false, reason: "This message is not addressed to an org agent." };
    }
    // A pinned ID rejects anything else, but pinning waits until a
    // signature verifies below: an unverified message never sets it.
    if (this.orgId && this.orgId !== addressed[1]) {
      return { accepted: false, reason: "This message is addressed to a different org." };
    }
    if (!msg.approvedByHumanId) {
      return { accepted: false, reason: "Consent needs a person's approval." };
    }
    const expected = await this.keyForSender(msg.fromAgentId);
    if (!expected) {
      return { accepted: false, reason: `Unknown sender: ${msg.fromAgentId}.` };
    }
    if (!(await verifyMessage(msg, expected))) {
      return { accepted: false, reason: "Bad consent signature." };
    }
    if (!this.orgId) {
      this.orgId = addressed[1];
      await this.ctx.storage.put("orgId", this.orgId);
    }

    const payload = msg.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { accepted: false, reason: "Consent payload must be an object." };
    }
    const sender = senderPerson(msg.fromAgentId);
    const owner = this.caseOwner(msg.caseId, msg.type === "consent.grant" ? sender : null);
    if (owner !== sender) {
      return { accepted: false, reason: "Only the resident who shared this case can change it." };
    }
    const now = new Date().toISOString();
    if (msg.type === "consent.revoke") {
      const delivery = this.applyDelivery(msg.fromAgentId, msg.idempotencyKey, () => {
        this.appendEvent(msg.caseId, "revoke", sender, "", msg.id, now, msg.idempotencyKey);
      });
      if (delivery === "duplicate") return { accepted: true, duplicate: true };
      if (delivery === "unavailable") return { accepted: false, reason: "The org cannot record this delivery right now. Retry.", retryable: true };
      this.audit("consent.revoke", { caseId: msg.caseId, from: msg.fromAgentId });
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
    const delivery = this.applyDelivery(msg.fromAgentId, msg.idempotencyKey, () => {
      this.db().exec("UPDATE case_owners SET expires_at_ms = ? WHERE case_id = ?", expiresAtMs, msg.caseId);
      this.appendEvent(msg.caseId, "share", sender, payload.purpose as string, msg.id, now, msg.idempotencyKey);
    });
    if (delivery === "duplicate") return { accepted: true, duplicate: true };
    if (delivery === "unavailable") return { accepted: false, reason: "The org cannot record this delivery right now. Retry.", retryable: true };
    this.audit("consent.grant", { caseId: msg.caseId, from: msg.fromAgentId });
    this.syncState();
    return { accepted: true };
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
  private applyDelivery(fromAgentId: string, idempotencyKey: string, append: () => void) {
    return applyConsentDelivery(this.db(), fromAgentId, idempotencyKey, append, (fn) =>
      this.ctx.storage.transactionSync(fn),
    );
  }

  // Whether this org recorded a consent event under a delivery key.
  // The person's agent asks this to reconcile a share; agent-to-agent
  // only. Reads the event record, never the dedupe marker: a marker can
  // survive a crash that the event did not. The sender stays on the
  // signature for the agent-to-agent contract; keys embed the sender, so
  // the key alone identifies the record. A pure historical fact: expiry
  // is enforced on case reads, not by rewriting delivery history.
  async hasConsentRecord(_fromAgentId: string, idempotencyKey: string): Promise<boolean> {
    return consentEventRecorded(this.db(), idempotencyKey);
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
    event: "share" | "revoke",
    personId: string,
    purpose: string,
    messageId: string,
    at: string,
    idempotencyKey: string,
  ) {
    this.db().exec(
      "INSERT INTO case_events(case_id, event, person_id, purpose, message_id, at, idempotency_key) VALUES (?,?,?,?,?,?,?)",
      caseId, event, personId, purpose, messageId, at, idempotencyKey,
    );
  }

  async listCases(verifiedOrg: string): Promise<SharedCase[]> {
    await this.assertOrg(verifiedOrg);
    return this.activeCases();
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

function senderPerson(fromAgentId: string): string {
  return fromAgentId.startsWith("person:") ? fromAgentId.slice("person:".length) : fromAgentId;
}
