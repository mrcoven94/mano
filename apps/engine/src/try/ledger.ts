// One Durable Object for the judge demo at withmano.com/try: every run, its
// append-only event log, and the limits. They live here so they hold across
// every Worker instance, and the daily cap in particular cannot be raced.
import { DurableObject } from "cloudflare:workers";
import { isTryPerson, type TryEvent, type TryLogged, type TryScenario } from "@mano/protocol";

import type { Env } from "../env.js";

// Runs across everyone in a UTC day. Past this the page says the demo is
// paused and plays a recording. A filing run costs a few model calls, a fill
// and Guardian checks, and Meta does not stop calls at a spend amount.
export const DAILY_RUN_CAP = 60;
export const IP_RUNS_PER_HOUR = 8;
export const MAX_ACTIVE_RUNS = 4;
// A run nobody finished stops holding its session's slot after this long.
const RUN_EXPIRES_MS = 15 * 60_000;
// A leg whose request died stops blocking the next try after this long.
const LEG_EXPIRES_MS = 150_000;
const KEEP_MS = 2 * 24 * 3_600_000;
// Measured cold start of Guardian's GPU, shown as the countdown.
export const GUARDIAN_COLD_SECONDS = 180;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type StartResult = { ok: true; runId: string; handleHash: string } | { ok: false; refused: "paused" | "rate" | "busy" | "full" };

export interface TryRun {
  id: string;
  handleHash: string;
  scenario: TryScenario;
  leg: number;
  turn: number;
  doc: number;
  done: boolean;
}

export class TryLedger extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, ip TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, scenario TEXT NOT NULL,
        leg INTEGER NOT NULL DEFAULT 0, turn INTEGER NOT NULL DEFAULT 0, doc INTEGER NOT NULL DEFAULT 0, screens INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, leg_started_at INTEGER);
      CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
      CREATE TABLE IF NOT EXISTS events (run TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run, seq));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }

  private count(query: string, ...args: (string | number)[]): number {
    return Number(this.sql.exec(query, ...args).one().n);
  }

  private dayStart(now: number): number {
    return now - (now % DAY_MS);
  }

  paused(now = Date.now()): boolean {
    return this.count("SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?", this.dayStart(now)) >= DAILY_RUN_CAP;
  }

  start(input: { session: string; ip: string; scenario: TryScenario; runId: string; handleHash: string }, now = Date.now()): StartResult {
    this.prune(now);
    if (this.paused(now)) return { ok: false, refused: "paused" };
    if (this.count("SELECT COUNT(*) AS n FROM runs WHERE ip = ? AND started_at >= ?", input.ip, now - HOUR_MS) >= IP_RUNS_PER_HOUR) {
      return { ok: false, refused: "rate" };
    }
    if (this.count("SELECT COUNT(*) AS n FROM runs WHERE session = ? AND done = 0", input.session) > 0) return { ok: false, refused: "busy" };
    if (this.count("SELECT COUNT(*) AS n FROM runs WHERE done = 0") >= MAX_ACTIVE_RUNS) return { ok: false, refused: "full" };
    this.sql.exec(
      "INSERT INTO runs (id, session, ip, handle, scenario, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.runId,
      input.session,
      input.ip,
      input.handleHash,
      input.scenario,
      now,
    );
    return { ok: true, runId: input.runId, handleHash: input.handleHash };
  }

  private prune(now: number): void {
    this.sql.exec("UPDATE runs SET done = 1 WHERE done = 0 AND started_at < ?", now - RUN_EXPIRES_MS);
    const old = this.sql.exec("SELECT id, screens FROM runs WHERE started_at < ?", now - KEEP_MS).toArray();
    for (const row of old) {
      const id = String(row.id);
      const keys = Array.from({ length: Number(row.screens) }, (_, n) => screenKey(id, n + 1));
      if (keys.length > 0) this.ctx.waitUntil(this.env.FILES.delete(keys));
      this.sql.exec("DELETE FROM events WHERE run = ?", id);
      this.sql.exec("DELETE FROM runs WHERE id = ?", id);
    }
  }

  run(id: string): TryRun | null {
    const row = this.sql.exec("SELECT id, handle, scenario, leg, turn, doc, done FROM runs WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    return {
      id: String(row.id),
      handleHash: String(row.handle),
      scenario: String(row.scenario) as TryScenario,
      leg: Number(row.leg),
      turn: Number(row.turn),
      doc: Number(row.doc),
      done: Number(row.done) === 1,
    };
  }

  // Claims one leg of a run, so a double press or a retried request cannot
  // run it twice at once. False when another request holds it.
  beginLeg(id: string, leg: number, now = Date.now()): boolean {
    const claimed = this.sql
      .exec(
        "UPDATE runs SET leg_started_at = ? WHERE id = ? AND leg = ? AND done = 0 AND (leg_started_at IS NULL OR leg_started_at < ?) RETURNING id",
        now,
        id,
        leg,
        now - LEG_EXPIRES_MS,
      )
      .toArray();
    return claimed.length === 1;
  }

  endLeg(id: string, nextLeg: number, done: boolean): void {
    this.sql.exec("UPDATE runs SET leg = ?, done = ?, leg_started_at = NULL WHERE id = ?", nextLeg, done ? 1 : 0, id);
  }

  // The next number of a run's turns or documents: each is used once.
  next(id: string, column: "turn" | "doc"): number {
    const row = this.sql.exec(`UPDATE runs SET ${column} = ${column} + 1 WHERE id = ? RETURNING ${column} AS n`, id).one();
    return Number(row.n);
  }

  append(id: string, event: TryEvent, now = Date.now()): void {
    const seq = this.count("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE run = ?", id);
    this.sql.exec("INSERT INTO events (run, seq, at, body) VALUES (?, ?, ?, ?)", id, seq, now, JSON.stringify(event));
  }

  private activeRunOf(handleHash: string): string | null {
    const row = this.sql.exec("SELECT id FROM runs WHERE handle = ? AND done = 0", handleHash).toArray()[0];
    return row ? String(row.id) : null;
  }

  // From the agent and the person's own Durable Object, which know only the
  // handle. A handle with no running demo is dropped.
  report(handleHash: string, event: TryEvent): void {
    const id = this.activeRunOf(handleHash);
    if (id) this.append(id, event);
  }

  // The next screen's storage key for this handle's running demo.
  reserveScreen(handleHash: string): { runId: string; n: number; key: string } | null {
    const id = this.activeRunOf(handleHash);
    if (!id) return null;
    const row = this.sql.exec("UPDATE runs SET screens = screens + 1 WHERE id = ? RETURNING screens AS n", id).one();
    const n = Number(row.n);
    return { runId: id, n, key: screenKey(id, n) };
  }

  read(id: string, after: number): TryLogged[] {
    return this.sql
      .exec("SELECT seq, at, body FROM events WHERE run = ? AND seq > ? ORDER BY seq", id, after)
      .toArray()
      .map((row) => ({ ...(JSON.parse(String(row.body)) as TryEvent), seq: Number(row.seq), at: Number(row.at) }));
  }

  // How long Guardian has left, from when this demo first found it cold. A
  // real clock: it does not restart when the page asks again.
  guardianWarming(ready: boolean, now = Date.now()): number {
    if (ready) {
      this.sql.exec("DELETE FROM meta WHERE key = 'warming_since'");
      return 0;
    }
    this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('warming_since', ?)", now);
    const since = this.count("SELECT value AS n FROM meta WHERE key = 'warming_since'");
    return Math.max(0, GUARDIAN_COLD_SECONDS - Math.floor((now - since) / 1000));
  }
}

export const screenKey = (runId: string, n: number): string => `try/${runId}/${n}.png`;

// For the person's Durable Object: reports a Guardian call on a demo person,
// and costs nothing for anyone else.
export function reportTryEvent(env: Env, personId: string, event: TryEvent): void {
  if (!isTryPerson(personId)) return;
  const ledger = env.TRY_LEDGER.get(env.TRY_LEDGER.idFromName("try")) as unknown as TryLedger;
  void Promise.resolve(ledger.report(personId.slice("handle-".length), event)).catch(() => undefined);
}
