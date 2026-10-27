import type { Approval, Attempt, Receipt } from "./types.js";
import type { ApprovalStore } from "./gateway.js";

// The gateway store on the agent's own SQLite. Approvals, attempts,
// receipts and audit rows live here, so eviction or redeploy never loses
// them and a retry can never double-execute. All methods are synchronous:
// paired writes with no await between them cannot interleave inside one
// agent, which is what makes consume atomic.

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
  sql.exec(`CREATE TABLE IF NOT EXISTS receipts(
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, action_type TEXT NOT NULL,
    recipient TEXT NOT NULL, status TEXT NOT NULL, external_id TEXT NOT NULL,
    simulated INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail TEXT NOT NULL,
    created_at TEXT NOT NULL)`);
}

const APPROVAL_COLUMNS =
  "id, action_type, recipient, purpose, document_hash, document_id, idempotency_key," +
  " status, approved_by, created_at, remind_at, expires_at, escalated, person_id," +
  " request_json, request_hash, problems_json";

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
    createdAt: r.created_at as string,
  };
}

export class SqlApprovalStore implements ApprovalStore {
  constructor(private sql: SqlStorage) {}

  getApproval(id: string): Approval | null {
    const rows = this.sql.exec(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`, id).toArray();
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

  consumeApprovalAndClaim(id: string, humanId: string, attempt: Attempt): Approval | null {
    let inserted = false;
    let adopted = false;
    try {
      this.sql.exec(
        "INSERT INTO attempts(idempotency_key, status, updated_at) VALUES (?,?,?)",
        attempt.key, attempt.status, attempt.updatedAt,
      );
      inserted = true;
    } catch {
      adopted = this.adoptUnknownAttempt(attempt.key, new Date(attempt.updatedAt));
      if (!adopted) return null;
    }
    const updated = this.sql.exec(
      "UPDATE approvals SET status = 'approved', approved_by = ? WHERE id = ? AND status = 'pending'",
      humanId, id,
    );
    if (updated.rowsWritten !== 1) {
      if (inserted) this.sql.exec("DELETE FROM attempts WHERE idempotency_key = ?", attempt.key);
      else this.sql.exec("UPDATE attempts SET status = 'unknown' WHERE idempotency_key = ?", attempt.key);
      return null;
    }
    return this.getApproval(id);
  }

  getReceiptByKey(key: string): Receipt | null {
    const rows = this.sql.exec(
      "SELECT id, idempotency_key, action_type, recipient, status, external_id, simulated, created_at FROM receipts WHERE idempotency_key = ?",
      key,
    ).toArray();
    if (rows.length === 0) return null;
    return receiptFromRow(rows[0] as Record<string, unknown>);
  }

  putReceipt(r: Receipt): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO receipts(id, idempotency_key, action_type, recipient, status, external_id, simulated, created_at) VALUES (?,?,?,?,?,?,?,?)",
      r.id, r.idempotencyKey, r.actionType, r.recipient, r.status, r.externalId,
      r.simulated ? 1 : 0, r.createdAt,
    );
  }

  getAttempt(key: string): Attempt | null {
    const rows = this.sql.exec(
      "SELECT idempotency_key, status, updated_at FROM attempts WHERE idempotency_key = ?",
      key,
    ).toArray() as unknown as { idempotency_key: string; status: Attempt["status"]; updated_at: string }[];
    if (rows.length === 0) return null;
    return { key: rows[0].idempotency_key, status: rows[0].status, updatedAt: rows[0].updated_at };
  }

  insertAttempt(a: Attempt): boolean {
    try {
      this.sql.exec(
        "INSERT INTO attempts(idempotency_key, status, updated_at) VALUES (?,?,?)",
        a.key, a.status, a.updatedAt,
      );
      return true;
    } catch {
      return false;
    }
  }

  adoptUnknownAttempt(key: string, now: Date): boolean {
    const updated = this.sql.exec(
      "UPDATE attempts SET status = 'in_flight', updated_at = ? WHERE idempotency_key = ? AND status = 'unknown'",
      now.toISOString(), key,
    );
    return updated.rowsWritten === 1;
  }

  updateAttempt(key: string, status: Attempt["status"]): void {
    this.sql.exec("UPDATE attempts SET status = ?, updated_at = ? WHERE idempotency_key = ?", status, new Date().toISOString(), key);
  }

  audit(entry: Record<string, unknown>): void {
    this.sql.exec(
      "INSERT INTO audit_log(event, detail, created_at) VALUES (?, ?, ?)",
      String(entry.event ?? "event"),
      JSON.stringify(entry),
      new Date().toISOString(),
    );
  }
}
