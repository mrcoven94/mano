// What the web keeps, in one SQLite Durable Object per name: "auth" holds
// sign-in challenges and shared limits, "person:<id>" holds that person's
// web conversation. The raw address is never stored; challenges hold only
// its hash. Messages older than RETENTION_MS are removed on read. Every
// time here is read inside the object when the call arrives, so a request
// held open by a slow body cannot act with the time it started.

export interface Sql {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

export interface WebMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
  // The approval question in this message while the browser has not yet
  // said it displayed it.
  ask?: { approvalId: string };
}

export interface ShownQuestion {
  approvalId: string;
  textHash: string;
}

export type TurnStart =
  | { kind: "run"; turn: number; receivedAt: number }
  | { kind: "busy" }
  | { kind: "answered"; reply: WebMessage };

const MAX_ATTEMPTS = 5;
const RETENTION_MS = 30 * 24 * 3600_000;
const MAX_MESSAGES = 200;
// A turn still marked running after this long lost its Worker and may run
// again under the same number; the agent's mutations converge on it.
const TURN_LEASE_MS = 120_000;

interface MessageRow {
  id: string;
  role: "user" | "agent";
  text: string;
  created_ms: number;
  approval_id: string | null;
}

const MESSAGE_SELECT =
  "SELECT m.id, m.role, m.text, m.created_ms, q.approval_id FROM messages m LEFT JOIN questions q ON q.message_id = m.id AND q.state = 'pending'";

function toMessage(row: MessageRow): WebMessage {
  const message: WebMessage = { id: row.id, role: row.role, text: row.text, createdAt: new Date(row.created_ms).toISOString() };
  if (row.approval_id) message.ask = { approvalId: row.approval_id };
  return message;
}

export class WebStore {
  constructor(
    private sql: Sql,
    private now: () => number = Date.now,
  ) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address_hash TEXT NOT NULL, expires_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, window_ms INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (op_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, received_ms INTEGER NOT NULL, started_ms INTEGER NOT NULL, state TEXT NOT NULL, reply_id TEXT);
      CREATE TABLE IF NOT EXISTS questions (approval_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, text_hash TEXT NOT NULL, state TEXT NOT NULL);
    `);
  }

  // One fixed window per key, read from this object's clock. A window only
  // moves forward, so nothing can reset a spent one by arriving late.
  allow(key: string, limit: number, windowMs: number): boolean {
    const nowMs = this.now();
    const row = this.sql.exec("SELECT window_ms, count FROM counters WHERE key = ?", key).toArray()[0] as
      | { window_ms: number; count: number }
      | undefined;
    const window = Math.max(nowMs - (nowMs % windowMs), row?.window_ms ?? 0);
    const count = row && row.window_ms === window ? row.count : 0;
    if (count >= limit) return false;
    this.sql.exec(
      "INSERT INTO counters(key, window_ms, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_ms = excluded.window_ms, count = excluded.count",
      key,
      window,
      count + 1,
    );
    return true;
  }

  createChallenge(id: string, addressHash: string, ttlMs: number): void {
    const nowMs = this.now();
    this.sql.exec("DELETE FROM challenges WHERE expires_ms < ?", nowMs);
    this.sql.exec("INSERT INTO challenges(id, address_hash, expires_ms) VALUES (?, ?, ?)", id, addressHash, nowMs + ttlMs);
  }

  dropChallenge(id: string): void {
    this.sql.exec("DELETE FROM challenges WHERE id = ?", id);
  }

  // Counts every wrong try and spends the challenge on a right one, so a
  // challenge opens one session and survives five guesses at most.
  spendChallenge(id: string, addressHash: string, correct: boolean): boolean {
    const row = this.sql.exec("SELECT address_hash, expires_ms, attempts, used FROM challenges WHERE id = ?", id).toArray()[0] as
      | { address_hash: string; expires_ms: number; attempts: number; used: number }
      | undefined;
    if (!row || row.used || row.expires_ms <= this.now() || row.attempts >= MAX_ATTEMPTS || row.address_hash !== addressHash) return false;
    if (!correct) {
      this.sql.exec("UPDATE challenges SET attempts = attempts + 1 WHERE id = ?", id);
      return false;
    }
    this.sql.exec("UPDATE challenges SET used = 1 WHERE id = ?", id);
    return true;
  }

  // The stored reply for an operation already answered, if any.
  answered(opId: string): WebMessage | null {
    const row = this.sql.exec("SELECT reply_id FROM turns WHERE op_id = ? AND state = 'done'", opId).toArray()[0] as { reply_id: string | null } | undefined;
    return row?.reply_id ? this.message(row.reply_id) : null;
  }

  beginTurn(opId: string, text: string): TurnStart {
    const nowMs = this.now();
    const row = this.sql.exec("SELECT turn, received_ms, started_ms, state, reply_id FROM turns WHERE op_id = ?", opId).toArray()[0] as
      | { turn: number; received_ms: number; started_ms: number; state: string; reply_id: string | null }
      | undefined;
    const reply = this.answered(opId);
    if (reply) return { kind: "answered", reply };
    if (row?.state === "running" && nowMs - row.started_ms < TURN_LEASE_MS) return { kind: "busy" };
    if (row) {
      this.sql.exec("UPDATE turns SET state = 'running', started_ms = ? WHERE op_id = ?", nowMs, opId);
      return { kind: "run", turn: row.turn, receivedAt: row.received_ms };
    }
    const last = this.sql.exec("SELECT COALESCE(MAX(turn), 0) AS turn FROM turns").toArray()[0] as { turn: number };
    const turn = last.turn + 1;
    this.sql.exec("INSERT INTO turns(op_id, turn, received_ms, started_ms, state) VALUES (?, ?, ?, ?, 'running')", opId, turn, nowMs, nowMs);
    this.sql.exec("INSERT INTO messages(id, role, text, created_ms) VALUES (?, 'user', ?, ?)", `u-${opId}`, text, nowMs);
    return { kind: "run", turn, receivedAt: nowMs };
  }

  // Stores the reply and, when it carries a question that survived whole,
  // the question waiting for the browser to say it displayed it. A message
  // holds only what its current reply asks: any older question goes with
  // the old words.
  finishTurn(opId: string, text: string, question: ShownQuestion | null): WebMessage {
    const id = `a-${opId}`;
    this.sql.exec("INSERT OR REPLACE INTO messages(id, role, text, created_ms) VALUES (?, 'agent', ?, ?)", id, text, this.now());
    this.sql.exec("UPDATE turns SET state = 'done', reply_id = ? WHERE op_id = ?", id, opId);
    this.sql.exec("DELETE FROM questions WHERE message_id = ?", id);
    if (question) {
      this.sql.exec(
        "INSERT OR REPLACE INTO questions(approval_id, message_id, text_hash, state) VALUES (?, ?, ?, 'pending')",
        question.approvalId,
        id,
        question.textHash,
      );
    }
    return this.message(id) as WebMessage;
  }

  failTurn(opId: string): void {
    this.sql.exec("UPDATE turns SET state = 'failed' WHERE op_id = ?", opId);
  }

  // The crisis line with no agent turn behind it, for a limit or a failure.
  // The person's words are kept when they could be read; a repeat answers
  // the same.
  recordCrisis(opId: string, text: string, line: string): WebMessage {
    const nowMs = this.now();
    const last = this.sql.exec("SELECT COALESCE(MAX(turn), 0) AS turn FROM turns").toArray()[0] as { turn: number };
    this.sql.exec("INSERT OR IGNORE INTO turns(op_id, turn, received_ms, started_ms, state) VALUES (?, ?, ?, ?, 'failed')", opId, last.turn + 1, nowMs, nowMs);
    if (text) this.sql.exec("INSERT OR IGNORE INTO messages(id, role, text, created_ms) VALUES (?, 'user', ?, ?)", `u-${opId}`, text, nowMs);
    return this.finishTurn(opId, line, null);
  }

  // The hash to report for this approval, only for the message that holds it.
  questionToReport(approvalId: string, messageId: string): string | null {
    const row = this.sql.exec("SELECT text_hash FROM questions WHERE approval_id = ? AND message_id = ? AND state = 'pending'", approvalId, messageId).toArray()[0] as
      | { text_hash: string }
      | undefined;
    return row?.text_hash ?? null;
  }

  settleQuestion(approvalId: string, messageId: string, state: "reported" | "closed"): void {
    this.sql.exec("UPDATE questions SET state = ? WHERE approval_id = ? AND message_id = ?", state, approvalId, messageId);
  }

  listMessages(): WebMessage[] {
    this.sql.exec("DELETE FROM messages WHERE created_ms < ?", this.now() - RETENTION_MS);
    const rows = this.sql.exec(`${MESSAGE_SELECT} ORDER BY m.seq DESC LIMIT ?`, MAX_MESSAGES).toArray() as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  private message(id: string): WebMessage | null {
    const row = this.sql.exec(`${MESSAGE_SELECT} WHERE m.id = ?`, id).toArray()[0] as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }
}
