import type { ActionType, Approval, Attempt, AuditEntry, Receipt } from "./types.js";
import type { ApprovalStore, ConsumeGuard } from "./gateway.js";

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

export function ensureGatewayTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS approvals(
    id TEXT PRIMARY KEY, action_type TEXT NOT NULL, recipient TEXT NOT NULL,
    purpose TEXT NOT NULL, document_hash TEXT, document_id TEXT,
    idempotency_key TEXT NOT NULL, status TEXT NOT NULL, approved_by TEXT,
    created_at TEXT NOT NULL, remind_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    escalated INTEGER NOT NULL, person_id TEXT NOT NULL, request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL, problems_json TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS attempts(
    idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  addColumn(sql, "attempts", "request_hash", "TEXT");
  addColumn(sql, "attempts", "action_type", "TEXT");
  addColumn(sql, "attempts", "recipient", "TEXT");
  addColumn(sql, "attempts", "person_id", "TEXT");
  sql.exec(`CREATE TABLE IF NOT EXISTS receipts(
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, action_type TEXT NOT NULL,
    recipient TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT NOT NULL,
    simulated INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  addColumn(sql, "receipts", "request_hash", "TEXT");
  sql.exec(`CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
}

const APPROVAL_COLUMNS =
  "id, action_type, recipient, purpose, document_hash, document_id, idempotency_key," +
  " status, approved_by, created_at, remind_at, expires_at, escalated, person_id," +
  " request_json, request_hash, problems_json";

const ATTEMPT_COLUMNS =
  "idempotency_key, status, updated_at, request_hash, action_type, recipient, person_id";

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
  };
}

export class SqlApprovalStore implements ApprovalStore {
  constructor(private sql: SqlStorage) {}

  getApproval(id: string): Approval | null {
    const rows = this.sql.exec(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`, id).toArray();
    if (rows.length === 0) return null;
    return approvalFromRow(rows[0] as Record<string, unknown>);
  }

  getApprovalByKey(key: string): Approval | null {
    const rows = this.sql.exec(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE idempotency_key = ?` +
        ` ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      key,
    ).toArray();
    if (rows.length === 0) return null;
    return approvalFromRow(rows[0] as Record<string, unknown>);
  }

  putApproval(a: Approval): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO approvals(${APPROVAL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, a.actionType, a.recipient, a.purpose, a.documentHash, a.documentId,
      a.idempotencyKey, a.status, a.approvedByHumanId, a.createdAt, a.remindAt, a.expiresAt,
      a.escalated ? 1 : 0, a.personId, a.requestJson, a.requestHash, JSON.stringify(a.problems),
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
          `INSERT INTO attempts(${ATTEMPT_COLUMNS}) VALUES (?,?,?,?,?,?,?)`,
          attempt.key, attempt.status, attempt.updatedAt, attempt.requestHash,
          attempt.actionType, attempt.recipient, attempt.personId,
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
        " WHERE id = ? AND status = 'pending' AND person_id = ? AND request_hash = ? AND expires_at > ?",
      humanId, id, guard.personId, guard.requestHash, new Date().toISOString(),
    );
    if (updated.rowsWritten !== 1) {
      if (inserted) this.sql.exec("DELETE FROM attempts WHERE idempotency_key = ?", attempt.key);
      else if (adoptedFrom) {
        this.sql.exec("UPDATE attempts SET status = ? WHERE idempotency_key = ?", adoptedFrom, attempt.key);
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
      `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE idempotency_key = ?`,
      key,
    ).toArray() as unknown as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return attemptFromRow(rows[0]);
  }

  insertAttempt(a: Attempt): boolean {
    try {
      this.sql.exec(
        `INSERT INTO attempts(${ATTEMPT_COLUMNS}) VALUES (?,?,?,?,?,?,?)`,
        a.key, a.status, a.updatedAt, a.requestHash, a.actionType, a.recipient, a.personId,
      );
      return true;
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
      "UPDATE attempts SET status = 'in_flight', updated_at = ? WHERE idempotency_key = ? AND status = ?",
      now.toISOString(), key, from,
    );
    return updated.rowsWritten === 1;
  }

  adoptForRecoveryIfApprovalLive(key: string, now: Date): boolean {
    // One statement: the attempt moves only while its approval is still
    // consumed and unexpired. Both timestamps are server-written UTC ISO,
    // so the lexical comparison is exact.
    const updated = this.sql.exec(
      "UPDATE attempts SET status = 'in_flight', updated_at = ? WHERE idempotency_key = ?" +
        " AND status IN ('in_flight', 'unknown')" +
        " AND EXISTS(SELECT 1 FROM approvals WHERE idempotency_key = ? AND status = 'approved' AND expires_at > ?)",
      now.toISOString(), key, key, now.toISOString(),
    );
    return updated.rowsWritten === 1;
  }

  claimRecoverableAttempt(key: string, olderThanIso: string, now: Date): boolean {
    const updated = this.sql.exec(
      "UPDATE attempts SET updated_at = ? WHERE idempotency_key = ? AND status IN ('in_flight', 'unknown') AND updated_at < ?",
      now.toISOString(), key, olderThanIso,
    );
    return updated.rowsWritten === 1;
  }

  listRecoverableAttempts(olderThanIso: string): Attempt[] {
    const rows = this.sql.exec(
      `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE status IN ('in_flight', 'unknown') AND updated_at < ?`,
      olderThanIso,
    ).toArray() as unknown as Record<string, unknown>[];
    return rows.map(attemptFromRow);
  }

  hasUnresolvedAttempts(): boolean {
    const rows = this.sql.exec(
      "SELECT idempotency_key FROM attempts WHERE status IN ('in_flight', 'unknown') LIMIT 1",
    ).toArray();
    return rows.length > 0;
  }

  updateAttempt(key: string, status: Attempt["status"]): void {
    this.sql.exec("UPDATE attempts SET status = ?, updated_at = ? WHERE idempotency_key = ?", status, new Date().toISOString(), key);
  }

  audit(entry: AuditEntry): void {
    this.sql.exec(
      "INSERT INTO audit_log(event, detail, created_at) VALUES (?, ?, ?)",
      String(entry.event ?? "event"),
      JSON.stringify(entry),
      new Date().toISOString(),
    );
  }
}
