// Per-person state the agent used to keep in Redis, now in the person's
// own SQLite: reminders, the turn ledger and the pending approval pointer.
// Every lifecycle change is one guarded statement, so a cancelled
// reminder never sends and a claimed one is never claimed twice.

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

// Caller-supplied identities (reminder IDs, turn IDs) are strict tokens:
// never free text, never a URL.
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const IDENTITY_RULE =
  "IDs must be 1 to 128 letters, digits, colons, hyphens or underscores, starting with a letter or digit.";

export function isIdentity(value: unknown): value is string {
  return typeof value === "string" && IDENTITY.test(value);
}

export function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// Request parsing, shared by the worker (which answers 400) and the agent
// (which re-checks, since RPC callers reach it directly).
export class AgentStateInputError extends Error {
  override name = "AgentStateInputError";
}

const MAX_REMINDER_TEXT = 1000;

export function requireIdentity(value: unknown): string {
  if (!isIdentity(value)) throw new AgentStateInputError(IDENTITY_RULE);
  return value;
}

export function requireGeneration(value: unknown): number {
  if (!isGeneration(value)) throw new AgentStateInputError("generation must be a whole number, 0 or more.");
  return value;
}

function requireInstantMs(value: unknown, field: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new AgentStateInputError(`${field} must be an ISO timestamp.`);
  return ms;
}

function fields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AgentStateInputError("Body must be a JSON object.");
  return raw as Record<string, unknown>;
}

export function parseReminderInput(raw: unknown): { id: string; text: string; dueAtMs: number; generation: number } {
  const f = fields(raw);
  const id = requireIdentity(f.id);
  if (typeof f.text !== "string" || !f.text || f.text.length > MAX_REMINDER_TEXT) {
    throw new AgentStateInputError(`text must be 1 to ${MAX_REMINDER_TEXT} characters.`);
  }
  return { id, text: f.text, dueAtMs: requireInstantMs(f.dueAt, "dueAt"), generation: requireGeneration(f.generation) };
}

export function parseTurnInput(raw: unknown): { turnId: string; receivedAt: string } {
  const f = fields(raw);
  return { turnId: requireIdentity(f.turnId), receivedAt: new Date(requireInstantMs(f.receivedAt, "receivedAt")).toISOString() };
}

export function parsePointerInput(raw: unknown): { approvalId: string; generation: number } {
  const f = fields(raw);
  if (typeof f.approvalId !== "string" || !f.approvalId) throw new AgentStateInputError("approvalId must be a string.");
  return { approvalId: f.approvalId, generation: requireGeneration(f.generation) };
}

export function ensureAgentStateTables(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS reminders(
    id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at_ms INTEGER NOT NULL, generation INTEGER NOT NULL,
    status TEXT NOT NULL, next_at_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT, claimed_at_ms INTEGER, created_at_ms INTEGER NOT NULL, finished_at_ms INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS turns(
    turn_id TEXT PRIMARY KEY, first_received_at TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS pending_pointer(
    slot INTEGER PRIMARY KEY CHECK (slot = 1), approval_id TEXT NOT NULL, generation INTEGER NOT NULL, set_at TEXT NOT NULL)`);
}

// scheduled: waiting for its time. sending: claimed by one delivery run.
// sent, dropped (Channels refused it for good), failed (retries ran out)
// and cancelled are final.
export type ReminderStatus = "scheduled" | "sending" | "sent" | "dropped" | "failed" | "cancelled";

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  generation: number;
  status: ReminderStatus;
  attempts: number;
}

const REMINDER_COLUMNS = "id, text, due_at_ms, generation, status, attempts";

function reminderFromRow(row: unknown): Reminder {
  const r = row as { id: string; text: string; due_at_ms: number; generation: number; status: ReminderStatus; attempts: number };
  return {
    id: r.id,
    text: r.text,
    dueAt: new Date(Number(r.due_at_ms)).toISOString(),
    generation: Number(r.generation),
    status: r.status,
    attempts: Number(r.attempts),
  };
}

export function getReminder(sql: SqlExec, id: string): Reminder | null {
  const rows = sql.exec(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`, id).toArray();
  return rows.length > 0 ? reminderFromRow(rows[0]) : null;
}

export function listReminders(sql: SqlExec): Reminder[] {
  return sql.exec(`SELECT ${REMINDER_COLUMNS} FROM reminders ORDER BY due_at_ms, id`).toArray().map(reminderFromRow);
}

// The same identity returns the reminder it already names; the same
// identity with different content is a conflict, never an overwrite.
export function createReminder(
  sql: SqlExec,
  input: { id: string; text: string; dueAtMs: number; generation: number },
  nowMs: number,
): { reminder: Reminder; created: boolean } | { conflict: Reminder } {
  const inserted = sql.exec(
    "INSERT OR IGNORE INTO reminders(id, text, due_at_ms, generation, status, next_at_ms, created_at_ms)" +
      " VALUES (?, ?, ?, ?, 'scheduled', ?, ?)",
    input.id, input.text, input.dueAtMs, input.generation, input.dueAtMs, nowMs,
  ).rowsWritten;
  const reminder = getReminder(sql, input.id)!;
  if (inserted > 0) return { reminder, created: true };
  const same =
    reminder.text === input.text &&
    reminder.generation === input.generation &&
    new Date(reminder.dueAt).getTime() === input.dueAtMs;
  return same ? { reminder, created: false } : { conflict: reminder };
}

// Cancels only a reminder still waiting. One already claimed for sending
// reports its status unchanged: its delivery is already on the wire.
export function cancelReminder(sql: SqlExec, id: string, nowMs: number): { reminder: Reminder | null; cancelled: boolean } {
  const updated = sql.exec(
    "UPDATE reminders SET status = 'cancelled', finished_at_ms = ? WHERE id = ? AND status = 'scheduled'",
    nowMs, id,
  ).rowsWritten;
  const reminder = getReminder(sql, id);
  return { reminder, cancelled: updated > 0 || reminder?.status === "cancelled" };
}

// Claims every due reminder for one delivery run, marked with its token.
// A claim whose lease ran out (the run crashed) can be claimed again;
// Channels dedupes on the reminder's delivery key, so that resend is safe.
export function claimDueReminders(sql: SqlExec, nowMs: number, leaseMs: number, token: string): Reminder[] {
  sql.exec(
    "UPDATE reminders SET status = 'sending', claim_token = ?, claimed_at_ms = ?, attempts = attempts + 1" +
      " WHERE (status = 'scheduled' AND next_at_ms <= ?) OR (status = 'sending' AND claimed_at_ms <= ?)",
    token, nowMs, nowMs, nowMs - leaseMs,
  );
  return sql
    .exec(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE claim_token = ? AND status = 'sending' ORDER BY due_at_ms, id`, token)
    .toArray()
    .map(reminderFromRow);
}

export type DeliveryOutcome = { kind: "sent" } | { kind: "dropped" } | { kind: "failed" } | { kind: "retry"; atMs: number };

// Only the run holding the claim may settle it, and only while it is
// still sending: a reclaimed or cancelled reminder ignores a late result.
export function finishReminder(sql: SqlExec, id: string, token: string, outcome: DeliveryOutcome, nowMs: number): boolean {
  if (outcome.kind === "retry") {
    return (
      sql.exec(
        "UPDATE reminders SET status = 'scheduled', next_at_ms = ?, claim_token = NULL, claimed_at_ms = NULL" +
          " WHERE id = ? AND claim_token = ? AND status = 'sending'",
        outcome.atMs, id, token,
      ).rowsWritten > 0
    );
  }
  return (
    sql.exec(
      "UPDATE reminders SET status = ?, finished_at_ms = ? WHERE id = ? AND claim_token = ? AND status = 'sending'",
      outcome.kind, nowMs, id, token,
    ).rowsWritten > 0
  );
}

// When the next delivery run is needed: the earliest waiting reminder, or
// the moment an outstanding claim's lease runs out.
export function nextReminderRunMs(sql: SqlExec, leaseMs: number): number | null {
  const row = sql.exec(
    "SELECT MIN(CASE status WHEN 'scheduled' THEN next_at_ms ELSE claimed_at_ms + ? END) AS at" +
      " FROM reminders WHERE status IN ('scheduled', 'sending')",
    leaseMs,
  ).toArray()[0] as { at: number | null } | undefined;
  return row?.at == null ? null : Number(row.at);
}

export interface Turn {
  turnId: string;
  firstReceivedAt: string;
  status: "open" | "complete";
  completedAt: string | null;
}

function turnFromRow(row: unknown): Turn {
  const r = row as { turn_id: string; first_received_at: string; status: Turn["status"]; completed_at: string | null };
  return { turnId: r.turn_id, firstReceivedAt: r.first_received_at, status: r.status, completedAt: r.completed_at };
}

export function getTurn(sql: SqlExec, turnId: string): Turn | null {
  const rows = sql.exec("SELECT turn_id, first_received_at, status, completed_at FROM turns WHERE turn_id = ?", turnId).toArray();
  return rows.length > 0 ? turnFromRow(rows[0]) : null;
}

// The first receive time is kept forever: a retried turn gets back the
// timing it was first seen with, whatever the retry sends.
export function putTurnIfAbsent(sql: SqlExec, turnId: string, receivedAt: string): { turn: Turn; created: boolean } {
  const inserted = sql.exec(
    "INSERT OR IGNORE INTO turns(turn_id, first_received_at, status) VALUES (?, ?, 'open')",
    turnId, receivedAt,
  ).rowsWritten;
  return { turn: getTurn(sql, turnId)!, created: inserted > 0 };
}

export function completeTurn(sql: SqlExec, turnId: string, completedAt: string): Turn | null {
  sql.exec("UPDATE turns SET status = 'complete', completed_at = ? WHERE turn_id = ? AND status = 'open'", completedAt, turnId);
  return getTurn(sql, turnId);
}

export interface PendingPointer {
  approvalId: string;
  generation: number;
  setAt: string;
}

export function setPendingPointer(sql: SqlExec, approvalId: string, generation: number, setAt: string): PendingPointer {
  sql.exec(
    "INSERT INTO pending_pointer(slot, approval_id, generation, set_at) VALUES (1, ?, ?, ?)" +
      " ON CONFLICT(slot) DO UPDATE SET approval_id = excluded.approval_id, generation = excluded.generation, set_at = excluded.set_at",
    approvalId, generation, setAt,
  );
  return { approvalId, generation, setAt };
}

// A pointer stored under another conversation generation belongs to a
// conversation that no longer exists: it reads as nothing.
export function getPendingPointer(sql: SqlExec, generation: number): PendingPointer | null {
  const row = sql.exec("SELECT approval_id, generation, set_at FROM pending_pointer WHERE slot = 1").toArray()[0] as
    | { approval_id: string; generation: number; set_at: string }
    | undefined;
  if (!row || Number(row.generation) !== generation) return null;
  return { approvalId: row.approval_id, generation: Number(row.generation), setAt: row.set_at };
}

export function clearPendingPointer(sql: SqlExec): boolean {
  return sql.exec("DELETE FROM pending_pointer WHERE slot = 1").rowsWritten > 0;
}

export interface ConversationRemoval {
  remindersCancelled: number;
  turnsDeleted: number;
  pendingPointerCleared: boolean;
  approvalsRejected: number;
  memoriesDeleted: number;
}

// Everything a deleted conversation leaves behind for this person. The
// caller runs it inside one transaction. In-flight reminders are cancelled
// too: their late result is ignored, and Channels refuses a send under the
// old conversation generation.
export function removeConversationState(sql: SqlExec, nowMs: number): ConversationRemoval {
  // Counted with SELECT, not rowsWritten: Durable Object SQLite counts
  // index writes there, and this answer must be exact.
  const count = (query: string) => Number((sql.exec(query).toArray()[0] as { n: number }).n);
  const remindersCancelled = count("SELECT COUNT(*) AS n FROM reminders WHERE status IN ('scheduled', 'sending')");
  sql.exec("UPDATE reminders SET status = 'cancelled', finished_at_ms = ? WHERE status IN ('scheduled', 'sending')", nowMs);
  const turnsDeleted = count("SELECT COUNT(*) AS n FROM turns");
  sql.exec("DELETE FROM turns");
  const pendingPointerCleared = count("SELECT COUNT(*) AS n FROM pending_pointer") > 0;
  clearPendingPointer(sql);
  const approvalsRejected = count("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'");
  sql.exec("UPDATE approvals SET status = 'rejected' WHERE status = 'pending'");
  const memoriesDeleted = count("SELECT COUNT(*) AS n FROM memory");
  sql.exec("DELETE FROM memory");
  return { remindersCancelled, turnsDeleted, pendingPointerCleared, approvalsRejected, memoriesDeleted };
}
