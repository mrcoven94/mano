// SQLite backing for one conversation. Each ConversationDO owns these
// tables in its own storage; nothing is shared across handles.
import type { EventAttachment } from "@mano/channels";
import {
  defaultMeta,
  type ApprovalRow,
  type ConversationMeta,
  type ConversationStore,
  type OutboundRow,
  type PendingInbound,
  type PersistedTurn,
} from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id TEXT PRIMARY KEY,
  recorded_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  turn INTEGER NOT NULL,
  introduced INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  opted_out INTEGER NOT NULL,
  running INTEGER NOT NULL,
  chat_id TEXT,
  handle_to TEXT,
  hour_key TEXT NOT NULL,
  hour_count INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  day_count INTEGER NOT NULL,
  busy_notice_key TEXT,
  last_inbound_ms INTEGER NOT NULL,
  byte_day_key TEXT NOT NULL DEFAULT '',
  byte_day_count INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  deleted_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending (
  event_id TEXT PRIMARY KEY,
  received_at_ms INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  handle_to TEXT NOT NULL,
  text TEXT,
  attachments_json TEXT NOT NULL,
  from_reconcile INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbounds (
  idem_key TEXT PRIMARY KEY,
  turn INTEGER NOT NULL,
  part INTEGER NOT NULL,
  tag TEXT NOT NULL,
  bubble_text TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  code TEXT,
  chat_id TEXT,
  message_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbounds_message ON outbounds (message_id);
CREATE TABLE IF NOT EXISTS held_receipts (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_id TEXT,
  state TEXT NOT NULL,
  code TEXT,
  recorded_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_held_receipts_message ON held_receipts (message_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  turn INTEGER PRIMARY KEY,
  items_json TEXT NOT NULL,
  chat_id TEXT,
  handle_to TEXT,
  answer_json TEXT,
  cost_usd REAL,
  cost_settled INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sends (
  agent_key TEXT PRIMARY KEY,
  turn INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`;

interface MetaRow {
  turn: number;
  introduced: number;
  closed: number;
  opted_out: number;
  running: number;
  chat_id: string | null;
  handle_to: string | null;
  hour_key: string;
  hour_count: number;
  day_key: string;
  day_count: number;
  busy_notice_key: string | null;
  last_inbound_ms: number;
  byte_day_key: string;
  byte_day_count: number;
  generation: number;
  deleted_at_ms: number;
  typing_since_ms?: number;
  typing_active?: number;
}

function firstRow<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T | null {
  const rows = cursor.toArray() as T[];
  return rows.length > 0 ? rows[0] : null;
}

type TurnRow = {
  turn: number;
  items_json: string;
  chat_id: string | null;
  handle_to: string | null;
  answer_json: string | null;
  cost_usd: number | null;
  cost_settled: number;
  attempts: number;
  state: PersistedTurn["state"];
  created_at_ms: number;
  updated_at_ms: number;
};

function turnFromRow(row: TurnRow): PersistedTurn {
  return {
    turn: row.turn,
    itemsJson: row.items_json,
    chatId: row.chat_id,
    to: row.handle_to,
    answerJson: row.answer_json,
    costUsd: row.cost_usd,
    costSettled: row.cost_settled === 1,
    attempts: row.attempts,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export class SqlConversationStore implements ConversationStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(SCHEMA);
    // Pre-launch migrations for dev databases created before the
    // review fixes added columns. Nothing has been deployed, so a plain
    // ALTER per column is enough; the first schema change after launch
    // gets a real migration.
    for (const ddl of [
      "ALTER TABLE outbounds ADD COLUMN bubble_text TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE outbounds ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE turns ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      // Native iMessage (LAP-636): tapbacks, inline replies, typing hold.
      "ALTER TABLE pending ADD COLUMN message_id TEXT",
      "ALTER TABLE outbounds ADD COLUMN reply_to TEXT",
      "ALTER TABLE meta ADD COLUMN typing_since_ms INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE meta ADD COLUMN typing_active INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.sql.exec(ddl);
      } catch {
        // The column already exists.
      }
    }
    const existing = firstRow(this.sql.exec("SELECT id FROM meta WHERE id = 1"));
    if (!existing) {
      this.sql.exec(
        "INSERT INTO meta (id, turn, introduced, closed, opted_out, running, chat_id, handle_to, hour_key, hour_count, day_key, day_count, busy_notice_key, last_inbound_ms) VALUES (1, 0, 0, 0, 0, 0, NULL, NULL, '', 0, '', 0, NULL, 0)",
      );
    }
  }

  hasEvent(eventId: string): boolean {
    return firstRow(this.sql.exec("SELECT event_id FROM events WHERE event_id = ?", eventId)) !== null;
  }

  recordEvent(eventId: string, kind: string, atMs: number): void {
    this.sql.exec("INSERT OR IGNORE INTO events (event_id, kind, recorded_at_ms) VALUES (?, ?, ?)", eventId, kind, atMs);
  }

  hasInboundMessage(messageId: string): boolean {
    return firstRow(this.sql.exec("SELECT message_id FROM inbound_messages WHERE message_id = ?", messageId)) !== null;
  }

  recordInboundMessage(messageId: string, atMs: number): void {
    this.sql.exec("INSERT OR IGNORE INTO inbound_messages (message_id, recorded_at_ms) VALUES (?, ?)", messageId, atMs);
  }

  meta(): ConversationMeta {
    const row = firstRow<MetaRow>(this.sql.exec("SELECT * FROM meta WHERE id = 1"));
    if (!row) return defaultMeta();
    return {
      turn: row.turn,
      introduced: row.introduced === 1,
      closed: row.closed === 1,
      optedOut: row.opted_out === 1,
      running: row.running === 1,
      chatId: row.chat_id,
      to: row.handle_to,
      hourKey: row.hour_key,
      hourCount: row.hour_count,
      dayKey: row.day_key,
      dayCount: row.day_count,
      busyNoticeKey: row.busy_notice_key,
      lastInboundMs: row.last_inbound_ms,
      typingSinceMs: row.typing_since_ms ?? 0,
      typingActive: row.typing_active === 1,
      byteDayKey: row.byte_day_key ?? "",
      byteDayCount: row.byte_day_count ?? 0,
      generation: row.generation ?? 0,
      deletedAtMs: row.deleted_at_ms ?? 0,
    };
  }

  saveMeta(meta: ConversationMeta): void {
    this.sql.exec(
      "UPDATE meta SET turn = ?, introduced = ?, closed = ?, opted_out = ?, running = ?, chat_id = ?, handle_to = ?, hour_key = ?, hour_count = ?, day_key = ?, day_count = ?, busy_notice_key = ?, last_inbound_ms = ?, byte_day_key = ?, byte_day_count = ?, generation = ?, deleted_at_ms = ?, typing_since_ms = ?, typing_active = ? WHERE id = 1",
      meta.turn,
      meta.introduced ? 1 : 0,
      meta.closed ? 1 : 0,
      meta.optedOut ? 1 : 0,
      meta.running ? 1 : 0,
      meta.chatId,
      meta.to,
      meta.hourKey,
      meta.hourCount,
      meta.dayKey,
      meta.dayCount,
      meta.busyNoticeKey,
      meta.lastInboundMs,
      meta.byteDayKey,
      meta.byteDayCount,
      meta.generation,
      meta.deletedAtMs,
      meta.typingSinceMs,
      meta.typingActive ? 1 : 0,
    );
  }

  addPending(item: PendingInbound): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO pending (event_id, received_at_ms, chat_id, handle_to, text, attachments_json, from_reconcile, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      item.eventId,
      item.receivedAtMs,
      item.chatId,
      item.to,
      item.text,
      JSON.stringify(item.attachments),
      item.fromReconcile ? 1 : 0,
      item.messageId ?? null,
    );
  }

  pending(): PendingInbound[] {
    const rows = this.sql.exec("SELECT * FROM pending ORDER BY received_at_ms ASC").toArray() as unknown as Array<{
      event_id: string;
      received_at_ms: number;
      chat_id: string;
      handle_to: string;
      text: string | null;
      attachments_json: string;
      from_reconcile: number;
      message_id: string | null;
    }>;
    return rows.map((r) => ({
      eventId: r.event_id,
      receivedAtMs: r.received_at_ms,
      chatId: r.chat_id,
      to: r.handle_to,
      text: r.text,
      attachments: JSON.parse(r.attachments_json) as EventAttachment[],
      fromReconcile: r.from_reconcile === 1,
      messageId: r.message_id ?? null,
    }));
  }

  clearPending(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const marks = eventIds.map(() => "?").join(",");
    this.sql.exec(`DELETE FROM pending WHERE event_id IN (${marks})`, ...eventIds);
  }

  addOutbound(row: OutboundRow): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO outbounds (idem_key, turn, part, tag, bubble_text, attempts, state, code, chat_id, message_id, created_at_ms, updated_at_ms, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.key,
      row.turn,
      row.part,
      row.tag,
      row.text,
      row.attempts,
      row.state,
      row.code,
      row.chatId,
      row.messageId,
      row.createdAtMs,
      row.updatedAtMs,
      row.replyTo ?? null,
    );
  }

  outboundByKey(key: string): OutboundRow | null {
    const row = firstRow<{
      idem_key: string;
      turn: number;
      part: number;
      tag: string;
      bubble_text: string;
      attempts: number;
      state: OutboundRow["state"];
      code: string | null;
      chat_id: string | null;
      message_id: string | null;
      reply_to?: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>(this.sql.exec("SELECT * FROM outbounds WHERE idem_key = ?", key));
    if (!row) return null;
    return {
      key: row.idem_key,
      turn: row.turn,
      part: row.part,
      tag: row.tag,
      text: row.bubble_text,
      attempts: row.attempts,
      state: row.state,
      code: row.code,
      chatId: row.chat_id,
      messageId: row.message_id,
      replyTo: row.reply_to ?? null,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  outboundByMessageId(messageId: string): OutboundRow | null {
    const row = firstRow<{ idem_key: string }>(
      this.sql.exec("SELECT * FROM outbounds WHERE message_id = ? LIMIT 1", messageId),
    );
    if (!row) return null;
    return this.outboundByKey(row.idem_key);
  }

  updateOutbound(key: string, patch: Partial<OutboundRow>): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const map: Record<string, string> = {
      turn: "turn",
      part: "part",
      tag: "tag",
      attempts: "attempts",
      state: "state",
      code: "code",
      chatId: "chat_id",
      messageId: "message_id",
      createdAtMs: "created_at_ms",
      updatedAtMs: "updated_at_ms",
    };
    for (const [field, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value as string | number | null);
      }
    }
    if (sets.length === 0) return;
    values.push(key);
    this.sql.exec(`UPDATE outbounds SET ${sets.join(", ")} WHERE idem_key = ?`, ...values);
  }

  outbounds(): OutboundRow[] {
    return (this.sql.exec("SELECT * FROM outbounds ORDER BY created_at_ms ASC").toArray() as unknown as Array<{
      idem_key: string;
      turn: number;
      part: number;
      tag: string;
      bubble_text: string;
      attempts: number;
      state: OutboundRow["state"];
      code: string | null;
      chat_id: string | null;
      message_id: string | null;
      reply_to?: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>).map((r) => ({
      key: r.idem_key,
      turn: r.turn,
      part: r.part,
      tag: r.tag,
      text: r.bubble_text,
      attempts: r.attempts,
      state: r.state,
      code: r.code,
      chatId: r.chat_id,
      messageId: r.message_id,
      replyTo: r.reply_to ?? null,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
    }));
  }

  holdReceipt(receipt: import("./store.js").HeldReceipt): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO held_receipts (event_id, message_id, chat_id, state, code, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      receipt.eventId,
      receipt.messageId,
      receipt.chatId,
      receipt.state,
      receipt.code,
      receipt.atMs,
    );
  }

  takeReceipts(messageId: string): import("./store.js").HeldReceipt[] {
    const taken = (this.sql.exec("SELECT * FROM held_receipts WHERE message_id = ? ORDER BY recorded_at_ms ASC", messageId).toArray() as unknown as Array<{
      event_id: string;
      message_id: string;
      chat_id: string | null;
      state: OutboundRow["state"];
      code: string | null;
      recorded_at_ms: number;
    }>).map((r) => ({
      eventId: r.event_id,
      messageId: r.message_id,
      chatId: r.chat_id,
      state: r.state,
      code: r.code,
      atMs: r.recorded_at_ms,
    }));
    if (taken.length > 0) {
      this.sql.exec("DELETE FROM held_receipts WHERE message_id = ?", messageId);
    }
    return taken;
  }

  addApproval(row: ApprovalRow): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO approvals (id, code_hash, summary, status, decision, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.codeHash,
      row.summary,
      row.status,
      row.decision,
      row.createdAtMs,
      row.expiresAtMs,
    );
  }

  pendingApprovals(nowMs: number): ApprovalRow[] {
    return (this.sql.exec("SELECT * FROM approvals WHERE status = 'pending' AND expires_at_ms > ?", nowMs).toArray() as unknown as Array<{
      id: string;
      code_hash: string;
      summary: string;
      status: ApprovalRow["status"];
      decision: ApprovalRow["decision"];
      created_at_ms: number;
      expires_at_ms: number;
    }>).map((r) => ({
      id: r.id,
      codeHash: r.code_hash,
      summary: r.summary,
      status: r.status,
      decision: r.decision,
      createdAtMs: r.created_at_ms,
      expiresAtMs: r.expires_at_ms,
    }));
  }

  answerApproval(id: string, decision: "yes" | "no"): void {
    this.sql.exec("UPDATE approvals SET status = 'answered', decision = ? WHERE id = ?", decision, id);
  }

  startTurn(row: PersistedTurn): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO turns (turn, items_json, chat_id, handle_to, answer_json, cost_usd, cost_settled, attempts, state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.turn,
      row.itemsJson,
      row.chatId,
      row.to,
      row.answerJson,
      row.costUsd,
      row.costSettled ? 1 : 0,
      row.attempts,
      row.state,
      row.createdAtMs,
      row.updatedAtMs,
    );
  }

  unfinishedTurn(): PersistedTurn | null {
    const row = firstRow<TurnRow>(this.sql.exec("SELECT * FROM turns WHERE state = 'started' ORDER BY turn ASC LIMIT 1"));
    return row ? turnFromRow(row) : null;
  }

  recentTurns(limit: number): PersistedTurn[] {
    const rows = this.sql.exec("SELECT * FROM turns WHERE state = 'finished' ORDER BY turn DESC LIMIT ?", limit).toArray() as unknown as TurnRow[];
    return rows.map(turnFromRow);
  }

  updateTurnAnswer(turn: number, answerJson: string, costUsd: number, atMs: number): void {
    this.sql.exec("UPDATE turns SET answer_json = ?, cost_usd = ?, updated_at_ms = ? WHERE turn = ?", answerJson, costUsd, atMs, turn);
  }

  markTurnSettled(turn: number, atMs: number): void {
    this.sql.exec("UPDATE turns SET cost_settled = 1, updated_at_ms = ? WHERE turn = ?", atMs, turn);
  }

  bumpTurnAttempt(turn: number, atMs: number): void {
    this.sql.exec("UPDATE turns SET attempts = attempts + 1, updated_at_ms = ? WHERE turn = ?", atMs, turn);
  }

  finishTurn(turn: number, atMs: number): void {
    this.sql.exec("UPDATE turns SET state = 'finished', updated_at_ms = ? WHERE turn = ?", atMs, turn);
  }

  agentSend(key: string): import("./store.js").AgentSendRow | null {
    const row = firstRow<{
      agent_key: string;
      turn: number;
      state: import("./store.js").AgentSendRow["state"];
      created_at_ms: number;
      updated_at_ms: number;
    }>(this.sql.exec("SELECT * FROM agent_sends WHERE agent_key = ?", key));
    if (!row) return null;
    return {
      key: row.agent_key,
      turn: row.turn,
      state: row.state,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  startAgentSend(row: import("./store.js").AgentSendRow): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_sends (agent_key, turn, state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      row.key,
      row.turn,
      row.state,
      row.createdAtMs,
      row.updatedAtMs,
    );
  }

  finishAgentSend(key: string, atMs: number): void {
    this.sql.exec("UPDATE agent_sends SET state = 'sent', updated_at_ms = ? WHERE agent_key = ?", atMs, key);
  }

  wipe(deletedAtMs: number): void {
    const meta = this.meta();
    this.sql.exec(
      "DELETE FROM events; DELETE FROM pending; DELETE FROM outbounds; DELETE FROM held_receipts; DELETE FROM approvals; DELETE FROM turns; DELETE FROM inbound_messages; DELETE FROM agent_sends;",
    );
    this.saveMeta({ ...defaultMeta(), generation: meta.generation + 1, turn: meta.turn, deletedAtMs });
  }
}
