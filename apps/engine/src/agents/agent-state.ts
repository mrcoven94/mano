// Per-person state the agent used to keep in Redis, now in the person's
// own SQLite: reminders, the turn ledger and the pending approval pointer.
// Every lifecycle change is one guarded statement, so a cancelled
// reminder never sends and a claimed one is never claimed twice. Every
// write carries the conversation generation it was prepared under and
// commits only while that generation is current (CURRENT_GENERATION, in
// the same statement), so work from a deleted conversation never lands.
import { CURRENT_GENERATION } from "../gateway/sql-store.js";

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

export function parseTurnInput(raw: unknown): { turnId: string; receivedAt: string; generation: number } {
  const f = fields(raw);
  return {
    turnId: requireIdentity(f.turnId),
    receivedAt: new Date(requireInstantMs(f.receivedAt, "receivedAt")).toISOString(),
    generation: requireGeneration(f.generation),
  };
}

export function parseGenerationInput(raw: unknown): { generation: number } {
  return { generation: requireGeneration(fields(raw).generation) };
}


export function parsePointerInput(raw: unknown): { approvalId: string; generation: number } {
  const f = fields(raw);
  if (typeof f.approvalId !== "string" || !f.approvalId) throw new AgentStateInputError("approvalId must be a string.");
  return { approvalId: f.approvalId, generation: requireGeneration(f.generation) };
}

// An action request the agent drafts for a turn names it as
// proposalTurn, outside the request itself (never part of what is frozen
// and hashed). null when it is present but not a turn ID.
export function splitProposalTurn(raw: unknown): { request: unknown; turnId: string | null } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("proposalTurn" in raw)) return { request: raw, turnId: null };
  const { proposalTurn, ...request } = raw as Record<string, unknown>;
  return isIdentity(proposalTurn) ? { request, turnId: proposalTurn } : null;
}

// A drafted proposal's order: its turn's first receive time, then the
// turn ID. null when the turn is not in the current conversation's ledger.
export function proposalOrderFor(sql: SqlExec, turnId: string): { receivedAt: string; turnId: string } | null {
  const row = sql.exec(`SELECT first_received_at FROM turns WHERE turn_id = ? AND generation = ${CURRENT_GENERATION}`, turnId).toArray()[0] as
    | { first_received_at: string }
    | undefined;
  return row ? { receivedAt: new Date(Date.parse(row.first_received_at)).toISOString(), turnId } : null;
}

export function ensureAgentStateTables(sql: SqlExec): void {
  // The person's files (texted photos among them), also created by
  // PersonAgent; here so a conversation delete can remove their rows.
  sql.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, r2_key TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS reminders(
    id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at_ms INTEGER NOT NULL, generation INTEGER NOT NULL,
    status TEXT NOT NULL, next_at_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT, claimed_at_ms INTEGER, created_at_ms INTEGER NOT NULL, finished_at_ms INTEGER,
    handoffs INTEGER NOT NULL DEFAULT 0)`);
  // The due lookup: waiting reminders by their next time.
  sql.exec("CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, next_at_ms)");
  sql.exec(`CREATE TABLE IF NOT EXISTS turns(
    turn_id TEXT PRIMARY KEY, first_received_at TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT,
    generation INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS pending_pointer(
    slot INTEGER PRIMARY KEY CHECK (slot = 1), approval_id TEXT NOT NULL, generation INTEGER NOT NULL, set_at TEXT NOT NULL)`);
  // Each conversation delete, by the generation it moved to, with its
  // answer: a retried delete gets the same answer and changes nothing.
  sql.exec(`CREATE TABLE IF NOT EXISTS conversation_deletes(
    generation INTEGER PRIMARY KEY, result_json TEXT NOT NULL, at_ms INTEGER NOT NULL)`);
  // The one delivery wake-up a person has: the schedule's ID and time.
  sql.exec(`CREATE TABLE IF NOT EXISTS reminder_wakeup(
    slot INTEGER PRIMARY KEY CHECK (slot = 1), schedule_id TEXT NOT NULL, at_ms INTEGER NOT NULL)`);
}

export function currentGeneration(sql: SqlExec): number {
  const row = sql.exec(`SELECT ${CURRENT_GENERATION} AS g`).toArray()[0] as { g: number | null } | undefined;
  return Number(row?.g ?? 0);
}

// scheduled: waiting for its time. claimed: taken by one delivery run,
// never yet handed to Channels, so it can still be cancelled. sending:
// handed to Channels at least once. Channels may have accepted it, so it
// never returns to a cancellable state: an uncertain answer or a crashed
// run leaves it sending, and the next run re-sends it under the same key
// for Channels to dedupe. sent, dropped (Channels refused it for good, or
// its conversation was deleted), failed (retries ran out) and cancelled
// are final.
export type ReminderStatus = "scheduled" | "claimed" | "sending" | "sent" | "dropped" | "failed" | "cancelled";

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
// Inserts only while the generation is current.
export function createReminder(
  sql: SqlExec,
  input: { id: string; text: string; dueAtMs: number; generation: number },
  nowMs: number,
): { reminder: Reminder; created: boolean } | { conflict: Reminder } | { stale: true } {
  const inserted = sql.exec(
    "INSERT OR IGNORE INTO reminders(id, text, due_at_ms, generation, status, next_at_ms, created_at_ms)" +
      ` SELECT ?, ?, ?, ?, 'scheduled', ?, ? WHERE ${CURRENT_GENERATION} = ?`,
    input.id, input.text, input.dueAtMs, input.generation, input.dueAtMs, nowMs, input.generation,
  ).rowsWritten;
  if (inserted === 0 && currentGeneration(sql) !== input.generation) return { stale: true };
  const reminder = getReminder(sql, input.id)!;
  if (inserted > 0) return { reminder, created: true };
  const same =
    reminder.text === input.text &&
    reminder.generation === input.generation &&
    new Date(reminder.dueAt).getTime() === input.dueAtMs;
  return same ? { reminder, created: false } : { conflict: reminder };
}

// Cancels a reminder that was never handed to Channels. One that ever
// reached sending answers "already on its way": its delivery may already
// be accepted, so it is never called back.
export function cancelReminder(
  sql: SqlExec,
  id: string,
  nowMs: number,
): { reminder: Reminder | null; cancelled: boolean; reason?: "already on its way" } {
  const updated = sql.exec(
    "UPDATE reminders SET status = 'cancelled', finished_at_ms = ? WHERE id = ? AND status IN ('scheduled', 'claimed') AND handoffs = 0",
    nowMs, id,
  ).rowsWritten;
  const reminder = getReminder(sql, id);
  if (updated > 0 || reminder?.status === "cancelled") return { reminder, cancelled: true };
  if (reminder && (reminder.status === "sending" || reminder.status === "sent")) {
    return { reminder, cancelled: false, reason: "already on its way" };
  }
  return { reminder, cancelled: false };
}

// Claims up to `limit` due reminders for one delivery run, marked with its
// token: waiting ones become claimed, and sending ones due for a re-send
// (an uncertain answer) or whose run died (lease out) stay sending. A
// claimed one whose run died is claimed again. Never moves a reminder
// back from sending.
export function claimDueReminders(sql: SqlExec, nowMs: number, leaseMs: number, token: string, limit: number): Reminder[] {
  sql.exec(
    "UPDATE reminders SET status = CASE status WHEN 'sending' THEN 'sending' ELSE 'claimed' END," +
      " claim_token = ?, claimed_at_ms = ?, attempts = attempts + 1" +
      " WHERE id IN (SELECT id FROM reminders WHERE (status = 'scheduled' AND next_at_ms <= ?)" +
      " OR (status = 'sending' AND claim_token IS NULL AND next_at_ms <= ?)" +
      " OR (status IN ('claimed', 'sending') AND claim_token IS NOT NULL AND claimed_at_ms <= ?)" +
      " ORDER BY next_at_ms, id LIMIT ?)",
    token, nowMs, nowMs, nowMs, nowMs - leaseMs, limit,
  );
  return sql
    .exec(
      `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE claim_token = ? AND status IN ('claimed', 'sending') ORDER BY due_at_ms, id`,
      token,
    )
    .toArray()
    .map(reminderFromRow);
}

// The commit point of each send, first or re-send, right before the call
// to Channels: the run must still hold the claim, the reminder must not
// have been cancelled, and its generation must be current, all in this
// statement. One whose conversation was deleted is dropped instead.
export function handOffReminder(sql: SqlExec, id: string, token: string, nowMs: number): boolean {
  const handed = sql.exec(
    "UPDATE reminders SET status = 'sending', handoffs = handoffs + 1" +
      ` WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending') AND generation = ${CURRENT_GENERATION}`,
    id, token,
  ).rowsWritten;
  if (handed > 0) return true;
  sql.exec(
    "UPDATE reminders SET status = 'dropped', finished_at_ms = ? WHERE id = ? AND claim_token = ? AND status IN ('claimed', 'sending')",
    nowMs, id, token,
  );
  return false;
}

export type DeliveryOutcome = { kind: "sent" } | { kind: "dropped" } | { kind: "failed" } | { kind: "retry"; atMs: number };

// Only the run holding the claim may settle it, and only once it was
// handed off: a reclaimed or cancelled reminder ignores a late result. A
// retry stays sending: the claim is released and the re-send waits for
// its time.
export function finishReminder(sql: SqlExec, id: string, token: string, outcome: DeliveryOutcome, nowMs: number): boolean {
  if (outcome.kind === "retry") {
    return (
      sql.exec(
        "UPDATE reminders SET next_at_ms = ?, claim_token = NULL, claimed_at_ms = NULL" +
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
    "SELECT MIN(CASE WHEN status = 'scheduled' OR claim_token IS NULL THEN next_at_ms ELSE claimed_at_ms + ? END) AS at" +
      " FROM reminders WHERE status IN ('scheduled', 'claimed', 'sending')",
    leaseMs,
  ).toArray()[0] as { at: number | null } | undefined;
  return row?.at == null ? null : Number(row.at);
}

export function getWakeup(sql: SqlExec): { scheduleId: string; atMs: number } | null {
  const row = sql.exec("SELECT schedule_id, at_ms FROM reminder_wakeup WHERE slot = 1").toArray()[0] as
    | { schedule_id: string; at_ms: number }
    | undefined;
  return row ? { scheduleId: row.schedule_id, atMs: Number(row.at_ms) } : null;
}

export function setWakeup(sql: SqlExec, scheduleId: string, atMs: number): void {
  sql.exec(
    "INSERT INTO reminder_wakeup(slot, schedule_id, at_ms) VALUES (1, ?, ?)" +
      " ON CONFLICT(slot) DO UPDATE SET schedule_id = excluded.schedule_id, at_ms = excluded.at_ms",
    scheduleId, atMs,
  );
}

export function clearWakeup(sql: SqlExec): void {
  sql.exec("DELETE FROM reminder_wakeup WHERE slot = 1");
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
export function putTurnIfAbsent(
  sql: SqlExec,
  turnId: string,
  receivedAt: string,
  generation: number,
): { turn: Turn; created: boolean } | { stale: true } {
  const inserted = sql.exec(
    `INSERT OR IGNORE INTO turns(turn_id, first_received_at, status, generation) SELECT ?, ?, 'open', ? WHERE ${CURRENT_GENERATION} = ?`,
    turnId, receivedAt, generation, generation,
  ).rowsWritten;
  if (inserted === 0 && currentGeneration(sql) !== generation) return { stale: true };
  return { turn: getTurn(sql, turnId)!, created: inserted > 0 };
}

export function completeTurn(sql: SqlExec, turnId: string, completedAt: string, generation: number): Turn | null | { stale: true } {
  if (currentGeneration(sql) !== generation) return { stale: true };
  sql.exec(
    `UPDATE turns SET status = 'complete', completed_at = ? WHERE turn_id = ? AND status = 'open' AND ${CURRENT_GENERATION} = ?`,
    completedAt, turnId, generation,
  );
  return getTurn(sql, turnId);
}

export interface PendingPointer {
  approvalId: string;
  generation: number;
  setAt: string;
}

export type PointerSet = { pointer: PendingPointer; superseded: false } | { pointer: PendingPointer | null; superseded: true } | null;

// Compare-and-set, in one statement: the pointer moves only while the
// generation is current and the approval is the person's latest proposal
// (ensureGatewayTables keeps it, moved only forward as approvals are
// drafted). A report for any other approval of this generation answers
// superseded and changes nothing. Repeating the report of the question
// already pointed at keeps when it was first shown.
export function setPendingPointer(sql: SqlExec, approvalId: string, generation: number, setAt: string): PointerSet {
  const written = sql.exec(
    "INSERT INTO pending_pointer(slot, approval_id, generation, set_at)" +
      ` SELECT 1, ?, ?, ? WHERE ${CURRENT_GENERATION} = ?` +
      ` AND EXISTS (SELECT 1 FROM latest_proposal WHERE slot = 1 AND approval_id = ? AND generation = ${CURRENT_GENERATION})` +
      " ON CONFLICT(slot) DO UPDATE SET approval_id = excluded.approval_id, generation = excluded.generation," +
      " set_at = CASE WHEN pending_pointer.approval_id = excluded.approval_id AND pending_pointer.generation = excluded.generation" +
      " THEN pending_pointer.set_at ELSE excluded.set_at END",
    approvalId, generation, setAt, generation, approvalId,
  ).rowsWritten;
  const current = getPendingPointer(sql, generation);
  if (written > 0 && current) return { pointer: current, superseded: false };
  const known =
    currentGeneration(sql) === generation &&
    sql.exec(`SELECT 1 FROM approvals WHERE id = ? AND generation = ${CURRENT_GENERATION}`, approvalId).toArray().length > 0;
  return known ? { pointer: current, superseded: true } : null;
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

// Compare-and-delete: clears the pointer only when it still names this
// approval under this generation, and that generation is current, so a
// stale turn can never clear the pointer of the conversation after it.
export function clearPendingPointer(sql: SqlExec, approvalId: string, generation: number): boolean {
  return (
    sql.exec(
      `DELETE FROM pending_pointer WHERE slot = 1 AND approval_id = ? AND generation = ? AND generation = ${CURRENT_GENERATION}`,
      approvalId, generation,
    ).rowsWritten > 0
  );
}

export interface ConversationRemoval {
  generation: number;
  remindersCancelled: number;
  remindersInFlight: number;
  turnsDeleted: number;
  pendingPointerCleared: boolean;
  approvalsRejected: number;
  approvalsRevoked: number;
  memoriesDeleted: number;
  documentsDeleted: number;
}

// Everything a deleted conversation leaves behind for this person, as a
// transition to toGeneration. The caller runs it inside one transaction.
// When the person is already at toGeneration or past it, nothing changes:
// the answer is the recorded one of the delete that got there, so a
// retried delete can never wipe the conversation that came after it.
// Otherwise the generation moves first, so any write still in
// preparation from the old conversation is stale.
// Reminders not yet handed to Channels are cancelled; those already
// handed off are counted in flight and settle as Channels answers (it
// refuses a send under the old generation). Approved actions that have
// not finished lose their authority to execute: their rows stay, revoked,
// for reconciliation only.
export function removeConversationState(sql: SqlExec, nowMs: number, toGeneration: number): ConversationRemoval {
  const current = currentGeneration(sql);
  if (toGeneration <= current) {
    const recorded = sql.exec(
      "SELECT result_json FROM conversation_deletes WHERE generation >= ? ORDER BY generation LIMIT 1",
      toGeneration,
    ).toArray()[0] as { result_json: string } | undefined;
    if (recorded) return JSON.parse(recorded.result_json) as ConversationRemoval;
    return {
      generation: current,
      remindersCancelled: 0,
      remindersInFlight: 0,
      turnsDeleted: 0,
      pendingPointerCleared: false,
      approvalsRejected: 0,
      approvalsRevoked: 0,
      memoriesDeleted: 0,
      documentsDeleted: 0,
    };
  }
  // Counted with SELECT, not rowsWritten: Durable Object SQLite counts
  // index writes there, and this answer must be exact.
  const count = (query: string) => Number((sql.exec(query).toArray()[0] as { n: number }).n);
  const generation = toGeneration;
  sql.exec("UPDATE conversation_state SET generation = ? WHERE slot = 1", generation);
  const remindersCancelled = count("SELECT COUNT(*) AS n FROM reminders WHERE status IN ('scheduled', 'claimed')");
  sql.exec("UPDATE reminders SET status = 'cancelled', finished_at_ms = ? WHERE status IN ('scheduled', 'claimed')", nowMs);
  const remindersInFlight = count("SELECT COUNT(*) AS n FROM reminders WHERE status = 'sending'");
  const turnsDeleted = count("SELECT COUNT(*) AS n FROM turns");
  sql.exec("DELETE FROM turns");
  const pendingPointerCleared = count("SELECT COUNT(*) AS n FROM pending_pointer") > 0;
  sql.exec("DELETE FROM pending_pointer");
  const approvalsRejected = count("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'");
  sql.exec("UPDATE approvals SET status = 'rejected' WHERE status = 'pending'");
  const unresolved =
    "status = 'approved' AND idempotency_key NOT IN (SELECT idempotency_key FROM attempts WHERE status = 'done')";
  const approvalsRevoked = count(`SELECT COUNT(*) AS n FROM approvals WHERE ${unresolved}`);
  sql.exec(`UPDATE approvals SET status = 'revoked' WHERE ${unresolved}`);
  const memoriesDeleted = count("SELECT COUNT(*) AS n FROM memory");
  sql.exec("DELETE FROM memory");
  // Their R2 objects go by prefix right after this transaction
  // (files.ts sweepDocuments).
  const documentsDeleted = count("SELECT COUNT(*) AS n FROM documents");
  sql.exec("DELETE FROM documents");
  const result: ConversationRemoval = {
    generation,
    remindersCancelled,
    remindersInFlight,
    turnsDeleted,
    pendingPointerCleared,
    approvalsRejected,
    approvalsRevoked,
    memoriesDeleted,
    documentsDeleted,
  };
  sql.exec(
    "INSERT INTO conversation_deletes(generation, result_json, at_ms) VALUES (?, ?, ?)",
    generation, JSON.stringify(result), nowMs,
  );
  return result;
}
