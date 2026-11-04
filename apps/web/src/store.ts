// What the web keeps, in one SQLite Durable Object per name: "auth" holds
// sign-in challenges and shared limits, "person:<id>" holds that person's
// web conversation. The raw address is never stored; challenges hold only
// its hash. Messages older than RETENTION_MS are removed on read.

export interface Sql {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

export interface WebMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  createdAt: string;
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
}

function toMessage(row: MessageRow): WebMessage {
  return { id: row.id, role: row.role, text: row.text, createdAt: new Date(row.created_ms).toISOString() };
}

export class WebStore {
  constructor(private sql: Sql) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, address_hash TEXT NOT NULL, expires_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, window_ms INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (op_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, received_ms INTEGER NOT NULL, started_ms INTEGER NOT NULL, state TEXT NOT NULL, reply_id TEXT);
    `);
  }

  // One fixed window per key. False once the window's limit is spent.
  allow(key: string, limit: number, windowMs: number, nowMs: number): boolean {
    const window = nowMs - (nowMs % windowMs);
    const row = this.sql.exec("SELECT window_ms, count FROM counters WHERE key = ?", key).toArray()[0] as
      | { window_ms: number; count: number }
      | undefined;
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

  createChallenge(id: string, addressHash: string, expiresMs: number, nowMs: number): void {
    this.sql.exec("DELETE FROM challenges WHERE expires_ms < ?", nowMs);
    this.sql.exec("INSERT INTO challenges(id, address_hash, expires_ms) VALUES (?, ?, ?)", id, addressHash, expiresMs);
  }

  dropChallenge(id: string): void {
    this.sql.exec("DELETE FROM challenges WHERE id = ?", id);
  }

  // Counts every wrong try and spends the challenge on a right one, so a
  // challenge opens one session and survives five guesses at most.
  spendChallenge(id: string, addressHash: string, correct: boolean, nowMs: number): boolean {
    const row = this.sql.exec("SELECT address_hash, expires_ms, attempts, used FROM challenges WHERE id = ?", id).toArray()[0] as
      | { address_hash: string; expires_ms: number; attempts: number; used: number }
      | undefined;
    if (!row || row.used || row.expires_ms <= nowMs || row.attempts >= MAX_ATTEMPTS || row.address_hash !== addressHash) return false;
    if (!correct) {
      this.sql.exec("UPDATE challenges SET attempts = attempts + 1 WHERE id = ?", id);
      return false;
    }
    this.sql.exec("UPDATE challenges SET used = 1 WHERE id = ?", id);
    return true;
  }

  beginTurn(opId: string, text: string, nowMs: number): TurnStart {
    const row = this.sql.exec("SELECT turn, received_ms, started_ms, state, reply_id FROM turns WHERE op_id = ?", opId).toArray()[0] as
      | { turn: number; received_ms: number; started_ms: number; state: string; reply_id: string | null }
      | undefined;
    if (row?.state === "done" && row.reply_id) {
      const reply = this.sql.exec("SELECT id, role, text, created_ms FROM messages WHERE id = ?", row.reply_id).toArray()[0] as MessageRow | undefined;
      if (reply) return { kind: "answered", reply: toMessage(reply) };
    }
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

  finishTurn(opId: string, text: string, nowMs: number): WebMessage {
    const id = `a-${opId}`;
    this.sql.exec("INSERT OR REPLACE INTO messages(id, role, text, created_ms) VALUES (?, 'agent', ?, ?)", id, text, nowMs);
    this.sql.exec("UPDATE turns SET state = 'done', reply_id = ? WHERE op_id = ?", id, opId);
    return { id, role: "agent", text, createdAt: new Date(nowMs).toISOString() };
  }

  failTurn(opId: string): void {
    this.sql.exec("UPDATE turns SET state = 'failed' WHERE op_id = ?", opId);
  }

  listMessages(nowMs: number): WebMessage[] {
    this.sql.exec("DELETE FROM messages WHERE created_ms < ?", nowMs - RETENTION_MS);
    const rows = this.sql.exec("SELECT id, role, text, created_ms FROM messages ORDER BY seq DESC LIMIT ?", MAX_MESSAGES).toArray() as MessageRow[];
    return rows.reverse().map(toMessage);
  }
}
