// ChannelStateDO: the one singleton holding the reconcile cursor and the
// daily model spend. ConversationDOs reach it for budget checks; the cron
// reaches it for the event-feed cursor.
import { DEFAULT_DAILY_BUDGET_USD, createLogger } from "@mano/channels";
import { SEEN_IDS_CAP } from "./global.js";
import type { Env } from "./env.js";
import {
  GlobalLedger,
  defaultGlobalState,
  type ByteReservation,
  type GlobalStateRow,
  type GlobalStore,
  type SpendReservation,
} from "./global.js";

class SqlGlobalStore implements GlobalStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS global_state (id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT, spend_day TEXT NOT NULL, spent_usd REAL NOT NULL, byte_day TEXT NOT NULL DEFAULT '', bytes_used INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS spend_reservations (res_key TEXT PRIMARY KEY, worst_usd REAL NOT NULL, day TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS byte_reservations (res_key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, day TEXT NOT NULL)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS chat_routes (chat_hash TEXT PRIMARY KEY, handle_hash TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seen_ids (event_id TEXT PRIMARY KEY, seen_at_ms INTEGER NOT NULL)");
    if (this.sql.exec("SELECT id FROM global_state WHERE id = 1").toArray().length === 0) {
      this.sql.exec("INSERT INTO global_state (id, cursor, spend_day, spent_usd) VALUES (1, NULL, '', 0)");
    }
  }

  state(): GlobalStateRow {
    const rows = this.sql.exec("SELECT * FROM global_state WHERE id = 1").toArray() as unknown as Array<{
      cursor: string | null;
      spend_day: string;
      spent_usd: number;
      byte_day: string | null;
      bytes_used: number | null;
    }>;
    const row = rows.length > 0 ? rows[0] : null;
    if (!row) return defaultGlobalState();
    return {
      cursor: row.cursor,
      spendDay: row.spend_day,
      spentUsd: row.spent_usd,
      byteDay: row.byte_day ?? "",
      bytesUsed: row.bytes_used ?? 0,
    };
  }

  save(state: GlobalStateRow): void {
    this.sql.exec(
      "UPDATE global_state SET cursor = ?, spend_day = ?, spent_usd = ?, byte_day = ?, bytes_used = ? WHERE id = 1",
      state.cursor,
      state.spendDay,
      state.spentUsd,
      state.byteDay,
      state.bytesUsed,
    );
  }

  spendReservations(day: string): SpendReservation[] {
    return (this.sql.exec("SELECT * FROM spend_reservations WHERE day = ?", day).toArray() as unknown as Array<{
      res_key: string;
      worst_usd: number;
      day: string;
    }>).map((r) => ({ key: r.res_key, worstUsd: r.worst_usd, day: r.day }));
  }

  reserveSpend(reservation: SpendReservation): void {
    this.sql.exec("INSERT OR REPLACE INTO spend_reservations (res_key, worst_usd, day) VALUES (?, ?, ?)", reservation.key, reservation.worstUsd, reservation.day);
  }

  settleSpend(key: string, day: string, actualUsd: number): void {
    this.sql.exec("DELETE FROM spend_reservations WHERE res_key = ?", key);
    const state = this.state();
    if (state.spendDay === day) {
      state.spentUsd += actualUsd;
    } else {
      state.spendDay = day;
      state.spentUsd = actualUsd;
    }
    this.save(state);
  }

  pruneSpendReservations(day: string): void {
    this.sql.exec("DELETE FROM spend_reservations WHERE day != ?", day);
  }

  byteReservations(day: string): ByteReservation[] {
    return (this.sql.exec("SELECT * FROM byte_reservations WHERE day = ?", day).toArray() as unknown as Array<{
      res_key: string;
      bytes: number;
      day: string;
    }>).map((r) => ({ key: r.res_key, bytes: r.bytes, day: r.day }));
  }

  reserveBytes(reservation: ByteReservation): void {
    this.sql.exec("INSERT OR REPLACE INTO byte_reservations (res_key, bytes, day) VALUES (?, ?, ?)", reservation.key, reservation.bytes, reservation.day);
  }

  settleBytes(key: string, day: string, actualBytes: number): void {
    this.sql.exec("DELETE FROM byte_reservations WHERE res_key = ?", key);
    const state = this.state();
    if (state.byteDay === day) {
      state.bytesUsed += actualBytes;
    } else {
      state.byteDay = day;
      state.bytesUsed = actualBytes;
    }
    this.save(state);
  }

  pruneByteReservations(day: string): void {
    this.sql.exec("DELETE FROM byte_reservations WHERE day != ?", day);
  }

  noteRoute(chatHash: string, handleHash: string): void {
    this.sql.exec("INSERT OR REPLACE INTO chat_routes (chat_hash, handle_hash) VALUES (?, ?)", chatHash, handleHash);
  }

  routeFor(chatHash: string): string | null {
    const rows = this.sql.exec("SELECT handle_hash FROM chat_routes WHERE chat_hash = ?", chatHash).toArray() as unknown as Array<{
      handle_hash: string;
    }>;
    return rows.length > 0 ? rows[0].handle_hash : null;
  }

  filterUnseen(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const known = new Set(
      (this.sql.exec(`SELECT event_id FROM seen_ids WHERE event_id IN (${marks})`, ...ids).toArray() as unknown as Array<{
        event_id: string;
      }>).map((r) => r.event_id),
    );
    return ids.filter((id) => !known.has(id));
  }

  noteSeen(ids: string[]): void {
    if (ids.length === 0) return;
    const atMs = Date.now();
    for (const id of ids) {
      this.sql.exec("INSERT OR IGNORE INTO seen_ids (event_id, seen_at_ms) VALUES (?, ?)", id, atMs);
    }
    this.sql.exec(
      `DELETE FROM seen_ids WHERE event_id NOT IN (SELECT event_id FROM seen_ids ORDER BY seen_at_ms DESC LIMIT ${SEEN_IDS_CAP})`,
    );
  }
}

export class ChannelStateDO implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private ledger(): GlobalLedger {
    const budget = Number(this.env.MANO_TEXT_DAILY_BUDGET_USD);
    return new GlobalLedger(
      new SqlGlobalStore(this.ctx.storage.sql),
      () => Date.now(),
      Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_DAILY_BUDGET_USD,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const logger = createLogger();
    if (request.method === "GET" && url.pathname === "/internal/state") {
      return Response.json(this.ledger().spent());
    }
    if (request.method === "POST" && url.pathname === "/internal/spend-reserve") {
      const body = (await request.json().catch(() => ({}))) as { key?: unknown; worstUsd?: unknown };
      if (typeof body.key !== "string" || typeof body.worstUsd !== "number") {
        return new Response("Bad reservation.", { status: 400 });
      }
      return Response.json(this.ledger().reserve(body.key, body.worstUsd));
    }
    if (request.method === "POST" && url.pathname === "/internal/spend-settle") {
      const body = (await request.json().catch(() => ({}))) as { key?: unknown; actualUsd?: unknown };
      if (typeof body.key !== "string" || typeof body.actualUsd !== "number") {
        return new Response("Bad settlement.", { status: 400 });
      }
      const result = this.ledger().settle(body.key, body.actualUsd);
      logger.info("spend_recorded", { spentUsd: result.spentUsd });
      return Response.json(result);
    }
    if (request.method === "POST" && url.pathname === "/internal/bytes-reserve") {
      const body = (await request.json().catch(() => ({}))) as { key?: unknown; bytes?: unknown };
      if (typeof body.key !== "string" || typeof body.bytes !== "number") {
        return new Response("Bad reservation.", { status: 400 });
      }
      return Response.json(this.ledger().byteReserve(body.key, body.bytes));
    }
    if (request.method === "POST" && url.pathname === "/internal/bytes-settle") {
      const body = (await request.json().catch(() => ({}))) as { key?: unknown; actualBytes?: unknown };
      if (typeof body.key !== "string" || typeof body.actualBytes !== "number") {
        return new Response("Bad settlement.", { status: 400 });
      }
      return Response.json(this.ledger().byteSettle(body.key, body.actualBytes));
    }
    if (request.method === "POST" && url.pathname === "/internal/route") {
      const body = (await request.json().catch(() => ({}))) as { chat?: unknown; handleHash?: unknown };
      if (typeof body.chat !== "string" || typeof body.handleHash !== "string") {
        return new Response("Bad route.", { status: 400 });
      }
      this.ledger().noteRoute(body.chat, body.handleHash);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/internal/route") {
      const chat = url.searchParams.get("chat") ?? "";
      return Response.json({ handleHash: chat ? this.ledger().routeFor(chat) : null });
    }
    if (request.method === "POST" && url.pathname === "/internal/seen-check") {
      const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
      return Response.json({ unseen: this.ledger().filterUnseen(ids) });
    }
    if (request.method === "POST" && url.pathname === "/internal/seen-note") {
      const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
      this.ledger().noteSeen(ids);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/internal/cursor") {
      return Response.json({ cursor: this.ledger().cursor() });
    }
    if (request.method === "POST" && url.pathname === "/internal/cursor") {
      const body = (await request.json().catch(() => ({}))) as { cursor?: string | null };
      const cursor = body.cursor === null || typeof body.cursor === "string" ? body.cursor : null;
      this.ledger().saveCursor(cursor);
      return Response.json({ ok: true });
    }
    return new Response("Not found.", { status: 404 });
  }
}
