// ChannelStateDO: the one singleton holding the reconcile cursor and the
// daily model spend. ConversationDOs reach it for budget checks; the cron
// reaches it for the event-feed cursor.
import { DEFAULT_DAILY_BUDGET_USD, createLogger } from "@mano/channels";
import type { Env } from "./env.js";
import { GlobalLedger, defaultGlobalState, type GlobalStateRow, type GlobalStore } from "./global.js";

class SqlGlobalStore implements GlobalStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS global_state (id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT, spend_day TEXT NOT NULL, spent_usd REAL NOT NULL)",
    );
    if (this.sql.exec("SELECT id FROM global_state WHERE id = 1").toArray().length === 0) {
      this.sql.exec("INSERT INTO global_state (id, cursor, spend_day, spent_usd) VALUES (1, NULL, '', 0)");
    }
  }

  state(): GlobalStateRow {
    const rows = this.sql.exec("SELECT * FROM global_state WHERE id = 1").toArray() as unknown as Array<{
      cursor: string | null;
      spend_day: string;
      spent_usd: number;
    }>;
    const row = rows.length > 0 ? rows[0] : null;
    if (!row) return defaultGlobalState();
    return { cursor: row.cursor, spendDay: row.spend_day, spentUsd: row.spent_usd };
  }

  save(state: GlobalStateRow): void {
    this.sql.exec("UPDATE global_state SET cursor = ?, spend_day = ?, spent_usd = ? WHERE id = 1", state.cursor, state.spendDay, state.spentUsd);
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
      return Response.json(this.ledger().check(0));
    }
    if (request.method === "POST" && url.pathname === "/internal/spend-check") {
      const body = (await request.json().catch(() => ({}))) as { estimateUsd?: number };
      return Response.json(this.ledger().check(typeof body.estimateUsd === "number" ? body.estimateUsd : 0));
    }
    if (request.method === "POST" && url.pathname === "/internal/spend-record") {
      const body = (await request.json().catch(() => ({}))) as { usd?: number };
      const result = this.ledger().record(typeof body.usd === "number" ? body.usd : 0);
      logger.info("spend_recorded", { spentUsd: result.spentUsd });
      return Response.json(result);
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
