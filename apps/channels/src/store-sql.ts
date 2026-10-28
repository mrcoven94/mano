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
} from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
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
  last_inbound_ms INTEGER NOT NULL
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
  state TEXT NOT NULL,
  code TEXT,
  chat_id TEXT,
  message_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbounds_message ON outbounds (message_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
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
}

function firstRow<T>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): T | null {
  const rows = cursor.toArray() as T[];
  return rows.length > 0 ? rows[0] : null;
}

export class SqlConversationStore implements ConversationStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(SCHEMA);
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
    };
  }

  saveMeta(meta: ConversationMeta): void {
    this.sql.exec(
      "UPDATE meta SET turn = ?, introduced = ?, closed = ?, opted_out = ?, running = ?, chat_id = ?, handle_to = ?, hour_key = ?, hour_count = ?, day_key = ?, day_count = ?, busy_notice_key = ?, last_inbound_ms = ? WHERE id = 1",
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
    );
  }

  addPending(item: PendingInbound): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO pending (event_id, received_at_ms, chat_id, handle_to, text, attachments_json, from_reconcile) VALUES (?, ?, ?, ?, ?, ?, ?)",
      item.eventId,
      item.receivedAtMs,
      item.chatId,
      item.to,
      item.text,
      JSON.stringify(item.attachments),
      item.fromReconcile ? 1 : 0,
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
    }>;
    return rows.map((r) => ({
      eventId: r.event_id,
      receivedAtMs: r.received_at_ms,
      chatId: r.chat_id,
      to: r.handle_to,
      text: r.text,
      attachments: JSON.parse(r.attachments_json) as EventAttachment[],
      fromReconcile: r.from_reconcile === 1,
    }));
  }

  clearPending(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const marks = eventIds.map(() => "?").join(",");
    this.sql.exec(`DELETE FROM pending WHERE event_id IN (${marks})`, ...eventIds);
  }

  addOutbound(row: OutboundRow): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO outbounds (idem_key, turn, part, tag, state, code, chat_id, message_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.key,
      row.turn,
      row.part,
      row.tag,
      row.state,
      row.code,
      row.chatId,
      row.messageId,
      row.createdAtMs,
      row.updatedAtMs,
    );
  }

  outboundByKey(key: string): OutboundRow | null {
    const row = firstRow<{
      idem_key: string;
      turn: number;
      part: number;
      tag: string;
      state: OutboundRow["state"];
      code: string | null;
      chat_id: string | null;
      message_id: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>(this.sql.exec("SELECT * FROM outbounds WHERE idem_key = ?", key));
    if (!row) return null;
    return {
      key: row.idem_key,
      turn: row.turn,
      part: row.part,
      tag: row.tag,
      state: row.state,
      code: row.code,
      chatId: row.chat_id,
      messageId: row.message_id,
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
      state: OutboundRow["state"];
      code: string | null;
      chat_id: string | null;
      message_id: string | null;
      created_at_ms: number;
      updated_at_ms: number;
    }>).map((r) => ({
      key: r.idem_key,
      turn: r.turn,
      part: r.part,
      tag: r.tag,
      state: r.state,
      code: r.code,
      chatId: r.chat_id,
      messageId: r.message_id,
      createdAtMs: r.created_at_ms,
      updatedAtMs: r.updated_at_ms,
    }));
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

  wipe(): void {
    this.sql.exec("DELETE FROM events; DELETE FROM pending; DELETE FROM outbounds; DELETE FROM approvals;");
    this.saveMeta(defaultMeta());
  }
}
