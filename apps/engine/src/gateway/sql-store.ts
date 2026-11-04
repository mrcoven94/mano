import type { ActionType, Approval, Attempt, Receipt } from "./types.js";
import type { AuditEntry } from "./audit.js";
import type { ApprovalStore, ConsumeGuard } from "./gateway.js";
import type { LatestProposal, ProposalOrder } from "./types.js";

// The gateway store on the agent's own SQLite. Approvals, attempts,
// receipts and audit rows live here, so eviction or redeploy never loses
// them and a retry can never double-execute. All methods are synchronous:
// paired writes with no await between them cannot interleave inside one
// agent, which is what makes consume atomic.

function addColumn(sql: SqlStorage, table: string, column: string, ddl: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    // The column already exists: additive migrations are idempotent.
  }
}

// The person's current conversation generation, as a SQL expression, so
// a write can check it in the same statement that writes.
export const CURRENT_GENERATION = "(SELECT generation FROM conversation_state WHERE slot = 1)";

export function ensureGatewayTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS conversation_state(
    slot INTEGER PRIMARY KEY CHECK (slot = 1), generation INTEGER NOT NULL)`);
  sql.exec("INSERT OR IGNORE INTO conversation_state(slot, generation) VALUES (1, 0)");
  sql.exec(`CREATE TABLE IF NOT EXISTS approvals(
    id TEXT PRIMARY KEY, action_type TEXT NOT NULL, recipient TEXT NOT NULL,
    purpose TEXT NOT NULL, document_hash TEXT, document_id TEXT,
    idempotency_key TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT,
    created_at TEXT NOT NULL, remind_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    escalated INTEGER NOT NULL, person_id TEXT NOT NULL, request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL, problems_json TEXT NOT NULL)`);
  addColumn(sql, "approvals", "generation", "INTEGER NOT NULL DEFAULT 0");
  // A drafted proposal's order (its turn's receive time, then turn ID),
  // and the person's latest proposal: moved only forward, in the same
  // synchronous step that creates the approval.
  addColumn(sql, "approvals", "proposal_received_at", "TEXT");
  addColumn(sql, "approvals", "proposal_turn_id", "TEXT");
  sql.exec(`CREATE TABLE IF NOT EXISTS latest_proposal(
    slot INTEGER PRIMARY KEY CHECK (slot = 1), generation INTEGER NOT NULL, approval_id TEXT NOT NULL,
    received_at TEXT NOT NULL, turn_id TEXT NOT NULL)`);
  // Per recipient, the latest turn that is correcting its form: drafts
  // from turns received before it are refused.
  sql.exec(`CREATE TABLE IF NOT EXISTS proposal_fences(
    recipient TEXT PRIMARY KEY, generation INTEGER NOT NULL, received_at TEXT NOT NULL, turn_id TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS attempts(
    idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  addColumn(sql, "attempts", "request_hash", "TEXT");
  addColumn(sql, "attempts", "action_type", "TEXT");
  addColumn(sql, "attempts", "recipient", "TEXT");
  addColumn(sql, "attempts", "person_id", "TEXT");
  addColumn(sql, "attempts", "version", "INTEGER NOT NULL DEFAULT 0");
  addColumn(sql, "attempts", "provider", "TEXT");
  addColumn(sql, "attempts", "lookup_failing_since", "TEXT");
  addColumn(sql, "attempts", "next_lookup_at", "TEXT");
  sql.exec(`CREATE TABLE IF NOT EXISTS receipts(
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, action_type TEXT NOT NULL,
    recipient TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT NOT NULL,
    simulated INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  addColumn(sql, "receipts", "request_hash", "TEXT");
  sql.exec(`CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
}

// True for a row of approvals that is not a drafted proposal, or is the
// latest one of the current generation.
const PROPOSAL_CURRENT_SQL =
  "(approvals.proposal_turn_id IS NULL OR approvals.id = " +
  `(SELECT approval_id FROM latest_proposal WHERE slot = 1 AND generation = ${CURRENT_GENERATION}))`;

const APPROVAL_COLUMNS =
  "id, action_type, recipient, purpose, document_hash, document_id, idempotency_key," +
  " status, approved_by, created_at, remind_at, expires_at, escalated, person_id," +
  " request_json, request_hash, problems_json";

const ATTEMPT_COLUMNS =
  "idempotency_key, status, updated_at, request_hash, action_type, recipient, person_id, provider";
const ATTEMPT_READ = `${ATTEMPT_COLUMNS}, version, lookup_failing_since, next_lookup_at`;

export function approvalFromRow(r: Record<string, unknown>): Approval {
  return {
    id: r.id as string,
    actionType: r.action_type as Approval["actionType"],
    recipient: r.recipient as string,
    purpose: r.purpose as string,
    documentHash: r.document_hash as string | null,
    documentId: r.document_id as string | null,
    idempotencyKey: r.idempotency_key as string,
    status: r.status as Approval["status"],
    approvedByHumanId: r.approved_by as string | null,
    personId: r.person_id as string,
    requestJson: r.request_json as string,
    requestHash: r.request_hash as string,
    problems: JSON.parse((r.problems_json as string) ?? "[]") as string[],
    createdAt: r.created_at as string,
    remindAt: r.remind_at as string,
    expiresAt: r.expires_at as string,
    escalated: (r.escalated as number) === 1,
  };
}

function receiptFromRow(r: Record<string, unknown>): Receipt {
  return {
    id: r.id as string,
    idempotencyKey: r.idempotency_key as string,
    actionType: r.action_type as Receipt["actionType"],
    recipient: r.recipient as string,
    status: r.status as Receipt["status"],
    externalId: r.external_id as string,
    simulated: (r.simulated as number) === 1,
    requestHash: (r.request_hash as string | null) ?? "",
    createdAt: r.created_at as string,
  };
}

function attemptFromRow(r: Record<string, unknown>): Attempt {
  return {
    key: r.idempotency_key as string,
    status: r.status as Attempt["status"],
    updatedAt: r.updated_at as string,
    requestHash: (r.request_hash as string | null) ?? "",
    actionType: (r.action_type as ActionType | null) ?? "submit",
    recipient: (r.recipient as string | null) ?? "",
    personId: (r.person_id as string | null) ?? "",
    version: Number(r.version ?? 0),
    provider: (r.provider as string | null) ?? null,
    lookupFailingSince: (r.lookup_failing_since as string | null) ?? null,
    nextLookupAt: (r.next_lookup_at as string | null) ?? null,
  };
}

export class SqlApprovalStore implements ApprovalStore {
  // transactionSync: the Durable Object's, so a transaction rolls back as
  // one. Without it each write commits on its own.
  constructor(
    private sql: SqlStorage,
    private transactionSync?: <T>(fn: () => T) => T,
  ) {}

  transaction<T>(fn: () => T): T {
    return this.transactionSync ? this.transactionSync(fn) : fn();
  }

  fenceProposals(recipient: string, order: ProposalOrder, generation: number): number | null {
    if (this.generation() !== generation) return null;
    this.sql.exec(
      "INSERT INTO proposal_fences(recipient, generation, received_at, turn_id) VALUES (?, ?, ?, ?)" +
        " ON CONFLICT(recipient) DO UPDATE SET generation = excluded.generation, received_at = excluded.received_at, turn_id = excluded.turn_id" +
        " WHERE proposal_fences.generation <> excluded.generation" +
        " OR (excluded.received_at, excluded.turn_id) > (proposal_fences.received_at, proposal_fences.turn_id)",
      recipient, generation, order.receivedAt, order.turnId,
    );
    return this.sql.exec(
      "UPDATE approvals SET status = 'rejected' WHERE status = 'pending' AND recipient = ? AND proposal_received_at IS NOT NULL" +
        ` AND generation = ${CURRENT_GENERATION}` +
        " AND (proposal_received_at, proposal_turn_id) < (SELECT received_at, turn_id FROM proposal_fences WHERE recipient = ?)",
      recipient, recipient,
    ).rowsWritten;
  }

  proposalFenced(recipient: string, order: ProposalOrder): boolean {
    const fence = this.sql
      .exec(`SELECT received_at, turn_id FROM proposal_fences WHERE recipient = ? AND generation = ${CURRENT_GENERATION}`, recipient)
      .toArray()[0] as { received_at: string; turn_id: string } | undefined;
    return !!fence && (order.receivedAt < fence.received_at || (order.receivedAt === fence.received_at && order.turnId < fence.turn_id));
  }

  getApproval(id: string): Approval | null {
    const rows = this.sql.exec(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`, id).toArray();
    if (rows.length === 0) return null;
    return approvalFromRow(rows[0] as Record<string, unknown>);
  }

  keyHeld(key: string): boolean {
    return (
      this.sql
        .exec("SELECT 1 FROM approvals WHERE idempotency_key = ? AND status IN ('pending', 'approved', 'retired', 'rejected', 'revoked') LIMIT 1", key)
        .toArray().length > 0
    );
  }

  getApprovalByKey(key: string): Approval | null {
    const rows = this.sql.exec(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE idempotency_key = ?` +
        ` ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'retired' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      key,
    ).toArray();
    if (rows.length === 0) return null;
    return approvalFromRow(rows[0] as Record<string, unknown>);
  }

  putApproval(a: Approval): void {
    this.sql.exec(
      // A rewrite keeps the generation the row was recorded under.
      `INSERT OR REPLACE INTO approvals(${APPROVAL_COLUMNS}, generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,` +
        `COALESCE((SELECT generation FROM approvals WHERE id = ?), ${CURRENT_GENERATION}))`,
      a.id, a.actionType, a.recipient, a.purpose, a.documentHash, a.documentId,
      a.idempotencyKey, a.status, a.approvedByHumanId, a.createdAt, a.remindAt, a.expiresAt,
      a.escalated ? 1 : 0, a.personId, a.requestJson, a.requestHash, JSON.stringify(a.problems), a.id,
    );
  }

  generation(): number {
    const row = this.sql.exec(`SELECT ${CURRENT_GENERATION} AS g`).toArray()[0] as { g: number | null } | undefined;
    return Number(row?.g ?? 0);
  }

  createApprovalForKey(a: Approval, generation: number, order?: ProposalOrder): Approval | null {
    const inserted = this.sql.exec(
      `INSERT INTO approvals(${APPROVAL_COLUMNS}, generation) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?` +
        " WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE idempotency_key = ? AND status IN ('pending', 'approved', 'retired', 'rejected', 'revoked'))" +
        ` AND ${CURRENT_GENERATION} = ?`,
      a.id, a.actionType, a.recipient, a.purpose, a.documentHash, a.documentId,
      a.idempotencyKey, a.status, a.approvedByHumanId, a.createdAt, a.remindAt, a.expiresAt,
      a.escalated ? 1 : 0, a.personId, a.requestJson, a.requestHash, JSON.stringify(a.problems), generation,
      a.idempotencyKey, generation,
    ).rowsWritten;
    if (inserted > 0) {
      // No await between the insert above and these writes.
      if (order) {
        this.sql.exec("UPDATE approvals SET proposal_received_at = ?, proposal_turn_id = ? WHERE id = ?", order.receivedAt, order.turnId, a.id);
        this.sql.exec(
          "INSERT INTO latest_proposal(slot, generation, approval_id, received_at, turn_id) VALUES (1, ?, ?, ?, ?)" +
            " ON CONFLICT(slot) DO UPDATE SET generation = excluded.generation, approval_id = excluded.approval_id," +
            " received_at = excluded.received_at, turn_id = excluded.turn_id" +
            " WHERE latest_proposal.generation <> excluded.generation" +
            " OR (excluded.received_at, excluded.turn_id) >= (latest_proposal.received_at, latest_proposal.turn_id)",
          generation, a.id, order.receivedAt, order.turnId,
        );
      }
      return a;
    }
    if (this.generation() !== generation) return null;
    const rows = this.sql.exec(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE idempotency_key = ? AND status IN ('pending', 'approved', 'retired', 'rejected', 'revoked')` +
        " ORDER BY CASE status WHEN 'rejected' THEN 0 WHEN 'revoked' THEN 1 WHEN 'retired' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END, created_at LIMIT 1",
      a.idempotencyKey,
    ).toArray();
    return rows.length > 0 ? approvalFromRow(rows[0] as Record<string, unknown>) : null;
  }

  latestProposal(): LatestProposal | null {
    const row = this.sql
      .exec(`SELECT approval_id, received_at, turn_id FROM latest_proposal WHERE slot = 1 AND generation = ${CURRENT_GENERATION}`)
      .toArray()[0] as { approval_id: string; received_at: string; turn_id: string } | undefined;
    return row ? { approvalId: row.approval_id, receivedAt: row.received_at, turnId: row.turn_id } : null;
  }

  rejectSupersededProposals(generation: number): number {
    return this.sql.exec(
      `UPDATE approvals SET status = 'rejected' WHERE status = 'pending' AND NOT (${PROPOSAL_CURRENT_SQL})` +
        ` AND generation = ${CURRENT_GENERATION} AND ${CURRENT_GENERATION} = ?`,
      generation,
    ).rowsWritten;
  }

  proposalCurrent(id: string): boolean {
    return this.sql.exec(`SELECT 1 FROM approvals WHERE id = ? AND NOT (${PROPOSAL_CURRENT_SQL})`, id).toArray().length === 0;
  }

  approvalCurrent(id: string): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM approvals WHERE id = ? AND generation = ${CURRENT_GENERATION}`, id).toArray().length > 0
    );
  }

  approvalAuthorized(id: string): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM approvals WHERE id = ? AND status = 'approved' AND generation = ${CURRENT_GENERATION}`, id)
        .toArray().length > 0
    );
  }

  rejectApprovalsForKey(key: string, personId: string): void {
    this.sql.exec(
      "UPDATE approvals SET status = 'rejected' WHERE idempotency_key = ? AND person_id = ? AND status = 'pending'",
      key, personId,
    );
  }

  keyDeclined(key: string): boolean {
    return (
      this.sql.exec("SELECT 1 FROM approvals WHERE idempotency_key = ? AND status = 'rejected' LIMIT 1", key).toArray()
        .length > 0
    );
  }

  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt, guard: ConsumeGuard): Approval | null {
    // The attempt claim and the guarded approval update below run with no
    // await between them, so no interleaving request can slip in.
    const prior = this.getAttempt(attempt.key);
    if (prior) {
      if (prior.status !== "unknown" && prior.status !== "failed") return null;
      if (prior.requestHash && attempt.requestHash && prior.requestHash !== attempt.requestHash) return null;
    }
    let inserted = false;
    let adoptedFrom: Attempt["status"] | null = null;
    if (!prior) {
      try {
        this.sql.exec(
          `INSERT INTO attempts(${ATTEMPT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?)`,
          attempt.key, attempt.status, attempt.updatedAt, attempt.requestHash,
          attempt.actionType, attempt.recipient, attempt.personId, attempt.provider ?? null,
        );
        inserted = true;
      } catch {
        return null;
      }
    } else if (prior.status === "unknown") {
      if (!this.adoptUnknownAttempt(attempt.key, new Date(attempt.updatedAt))) return null;
      adoptedFrom = "unknown";
    } else {
      if (!this.adoptFailedAttempt(attempt.key, new Date(attempt.updatedAt))) return null;
      adoptedFrom = "failed";
    }
    // Status, owner, request hash and expiry are re-checked inside the
    // consuming statement itself, not from the snapshot the gateway read
    // before its awaits. The clock is read here, at claim time.
    const updated = this.sql.exec(
      "UPDATE approvals SET status = 'approved', approved_by = ?" +
        " WHERE id = ? AND status = 'pending' AND person_id = ? AND request_hash = ? AND expires_at > ?" +
        " AND NOT EXISTS (SELECT 1 FROM approvals d WHERE d.idempotency_key = approvals.idempotency_key AND d.status = 'rejected')" +
        ` AND generation = ${CURRENT_GENERATION} AND ${PROPOSAL_CURRENT_SQL}`,
      humanId, id, guard.personId, guard.requestHash, new Date().toISOString(),
    );
    if (updated.rowsWritten !== 1) {
      if (inserted) this.sql.exec("DELETE FROM attempts WHERE idempotency_key = ?", attempt.key);
      else if (adoptedFrom) {
        this.sql.exec("UPDATE attempts SET status = ?, version = version + 1 WHERE idempotency_key = ?", adoptedFrom, attempt.key);
      }
      return null;
    }
    return this.getApproval(id);
  }

  expireApproval(id: string): boolean {
    return this.transition(id, "expired");
  }

  setApprovalBlocked(id: string): boolean {
    return this.transition(id, "blocked");
  }

  markApprovalStale(id: string): boolean {
    return this.transition(id, "stale");
  }

  private transition(id: string, to: Approval["status"]): boolean {
    const updated = this.sql.exec(
      "UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending'",
      to, id,
    );
    return updated.rowsWritten === 1;
  }

  setApprovalProblems(id: string, problems: string[]): void {
    this.sql.exec("UPDATE approvals SET problems_json = ? WHERE id = ?", JSON.stringify(problems), id);
  }

  escalateApproval(id: string): boolean {
    const updated = this.sql.exec(
      "UPDATE approvals SET escalated = 1 WHERE id = ? AND status = 'pending'",
      id,
    );
    return updated.rowsWritten === 1;
  }

  getReceiptByKey(key: string): Receipt | null {
    const rows = this.sql.exec(
      "SELECT id, idempotency_key, action_type, recipient, status, external_id, simulated, request_hash, created_at FROM receipts WHERE idempotency_key = ?",
      key,
    ).toArray();
    if (rows.length === 0) return null;
    return receiptFromRow(rows[0] as Record<string, unknown>);
  }

  putReceipt(r: Receipt): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO receipts(id, idempotency_key, action_type, recipient, status, external_id, simulated, request_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      r.id, r.idempotencyKey, r.actionType, r.recipient, r.status, r.externalId,
      r.simulated ? 1 : 0, r.requestHash, r.createdAt,
    );
  }

  getAttempt(key: string): Attempt | null {
    const rows = this.sql.exec(
      `SELECT ${ATTEMPT_READ} FROM attempts WHERE idempotency_key = ?`,
      key,
    ).toArray() as unknown as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return attemptFromRow(rows[0]);
  }

  insertAttempt(a: Attempt, generation?: number): boolean {
    try {
      if (generation === undefined) {
        this.sql.exec(
          `INSERT INTO attempts(${ATTEMPT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?)`,
          a.key, a.status, a.updatedAt, a.requestHash, a.actionType, a.recipient, a.personId, a.provider ?? null,
        );
        return true;
      }
      return (
        this.sql.exec(
          `INSERT INTO attempts(${ATTEMPT_COLUMNS}) SELECT ?,?,?,?,?,?,?,? WHERE ${CURRENT_GENERATION} = ?`,
          a.key, a.status, a.updatedAt, a.requestHash, a.actionType, a.recipient, a.personId, a.provider ?? null, generation,
        ).rowsWritten > 0
      );
    } catch {
      return false;
    }
  }

  adoptUnknownAttempt(key: string, now: Date): boolean {
    return this.adoptFrom(key, "unknown", now);
  }

  adoptFailedAttempt(key: string, now: Date): boolean {
    return this.adoptFrom(key, "failed", now);
  }

  private adoptFrom(key: string, from: Attempt["status"], now: Date): boolean {
    const updated = this.sql.exec(
      "UPDATE attempts SET status = 'in_flight', updated_at = ?, version = version + 1 WHERE idempotency_key = ? AND status = ?",
      now.toISOString(), key, from,
    );
    return updated.rowsWritten === 1;
  }

  adoptForRecoveryIfApprovalLive(key: string, now: Date): boolean {
    // One statement: the attempt moves only while its approval is still
    // consumed and unexpired. Both timestamps are server-written UTC ISO,
    // so the lexical comparison is exact.
    const updated = this.sql.exec(
      "UPDATE attempts SET status = 'in_flight', updated_at = ?, version = version + 1 WHERE idempotency_key = ?" +
        " AND status IN ('in_flight', 'unknown')" +
        " AND EXISTS(SELECT 1 FROM approvals WHERE idempotency_key = ? AND status = 'approved' AND expires_at > ?" +
        ` AND generation = ${CURRENT_GENERATION})`,
      now.toISOString(), key, key, now.toISOString(),
    );
    return updated.rowsWritten === 1;
  }

  claimRecoverableAttempt(key: string, olderThanIso: string, now: Date): boolean {
    const updated = this.sql.exec(
      "UPDATE attempts SET updated_at = ?, version = version + 1 WHERE idempotency_key = ? AND status IN ('in_flight', 'unknown') AND updated_at < ?",
      now.toISOString(), key, olderThanIso,
    );
    return updated.rowsWritten === 1;
  }

  listRecoverableAttempts(olderThanIso: string, nowIso = new Date().toISOString()): Attempt[] {
    const rows = this.sql.exec(
      `SELECT ${ATTEMPT_READ} FROM attempts WHERE status IN ('in_flight', 'unknown') AND updated_at < ?` +
        " AND (lookup_failing_since IS NULL OR next_lookup_at <= ?)",
      olderThanIso,
      nowIso,
    ).toArray() as unknown as Record<string, unknown>[];
    return rows.map(attemptFromRow);
  }

  hasUnresolvedAttempts(): boolean {
    const rows = this.sql.exec(
      "SELECT idempotency_key FROM attempts WHERE status IN ('in_flight', 'unknown')" +
        " AND (lookup_failing_since IS NULL OR next_lookup_at IS NOT NULL) LIMIT 1",
    ).toArray();
    return rows.length > 0;
  }

  setLookupSchedule(key: string, failingSince: string | null, nextLookupAt: string | null): void {
    this.sql.exec("UPDATE attempts SET lookup_failing_since = ?, next_lookup_at = ? WHERE idempotency_key = ?", failingSince, nextLookupAt, key);
  }

  updateAttempt(key: string, status: Attempt["status"]): void {
    this.sql.exec("UPDATE attempts SET status = ?, updated_at = ?, version = version + 1 WHERE idempotency_key = ?", status, new Date().toISOString(), key);
  }

  retireApproval(id: string, version: number): boolean {
    return (
      this.sql.exec(
        "UPDATE approvals SET status = 'retired' WHERE id = ? AND status = 'approved'" +
          " AND NOT EXISTS(SELECT 1 FROM receipts WHERE idempotency_key = approvals.idempotency_key)" +
          " AND EXISTS(SELECT 1 FROM attempts WHERE idempotency_key = approvals.idempotency_key AND status = 'failed' AND version = ?)",
        id, version,
      ).rowsWritten === 1
    );
  }

  failAttemptAt(key: string, version: number): boolean {
    return (
      this.sql.exec(
        "UPDATE attempts SET status = 'failed', updated_at = ?, version = version + 1 WHERE idempotency_key = ? AND version = ?" +
          " AND status IN ('in_flight', 'unknown', 'failed') AND NOT EXISTS(SELECT 1 FROM receipts WHERE idempotency_key = ?)",
        new Date().toISOString(), key, version, key,
      ).rowsWritten === 1
    );
  }

  audit<const T extends { event: string }>(entry: T & AuditEntry<T>): void {
    this.sql.exec(
      "INSERT INTO audit_log(event, detail, created_at) VALUES (?, ?, ?)",
      String(entry.event ?? "event"),
      JSON.stringify(entry),
      new Date().toISOString(),
    );
  }
}
