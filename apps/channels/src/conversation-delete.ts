// Deleting a conversation reaches past Channels: Engine holds the agent's
// state for the person (reminders, turn ledger, approval pointer, pending
// approvals, memory) and the agent holds its session history. Channels
// records the whole intent (new generation, files, Engine, agent) in the
// same synchronous step that wipes its own store, before anything is
// awaited, then works through it; anything that fails or throws is
// picked up from the record. Until Engine
// confirms it moved to the new generation, old approvals could still be
// answered, so the delete stays pending in the conversation's own SQLite:
// the alarm retries it with backoff, and the conversation answers only
// with the plain model (no agent, no tools, no approvals) until it is
// done. The caller is told pending, never ok, while anything is left.
import { deleteConversationInEngine, notifyAgentDeleted } from "@mano/channels";

import type { Env } from "./env.js";

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

export interface PendingDelete {
  handleHash: string;
  // The generation Channels moved to.
  generation: number;
  filesDone: boolean;
  engineDone: boolean;
  agentDone: boolean;
  attempts: number;
  nextAtMs: number;
}

export function ensureDeleteTable(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS engine_delete (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    handle_hash TEXT NOT NULL,
    generation INTEGER NOT NULL,
    files_done INTEGER NOT NULL,
    engine_done INTEGER NOT NULL,
    agent_done INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_at_ms INTEGER NOT NULL
  )`);
}

export function loadPendingDelete(sql: Sql): PendingDelete | null {
  ensureDeleteTable(sql);
  const row = sql.exec("SELECT * FROM engine_delete WHERE slot = 1").toArray()[0] as
    | {
        handle_hash: string;
        generation: number;
        files_done: number;
        engine_done: number;
        agent_done: number;
        attempts: number;
        next_at_ms: number;
      }
    | undefined;
  if (!row) return null;
  return {
    handleHash: row.handle_hash,
    generation: Number(row.generation),
    filesDone: Number(row.files_done) === 1,
    engineDone: Number(row.engine_done) === 1,
    agentDone: Number(row.agent_done) === 1,
    attempts: Number(row.attempts),
    nextAtMs: Number(row.next_at_ms),
  };
}

export function savePendingDelete(sql: Sql, p: PendingDelete): void {
  ensureDeleteTable(sql);
  sql.exec(
    "INSERT OR REPLACE INTO engine_delete (slot, handle_hash, generation, files_done, engine_done, agent_done, attempts, next_at_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
    p.handleHash,
    p.generation,
    p.filesDone ? 1 : 0,
    p.engineDone ? 1 : 0,
    p.agentDone ? 1 : 0,
    p.attempts,
    p.nextAtMs,
  );
}

export function clearPendingDelete(sql: Sql): void {
  ensureDeleteTable(sql);
  sql.exec("DELETE FROM engine_delete WHERE slot = 1");
}

// 30 seconds, doubling, at most an hour.
export function retryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function agentConfigured(env: Env): boolean {
  return Boolean(env.AGENT_URL && env.MANO_AGENT_SECRET && env.MANO_HANDLE_GRANT_SECRET);
}

function engineConfigured(env: Env): boolean {
  return Boolean(env.MANO_ENGINE_URL && env.MANO_ENGINE_CHANNELS_TOKEN && env.MANO_HANDLE_GRANT_SECRET);
}

// What a fresh delete still owes: Engine whenever Engine or the agent is
// configured (the agent's state lives in Engine), the agent whenever it is.
export function newPendingDelete(env: Env, handleHash: string, generation: number): PendingDelete {
  return {
    handleHash,
    generation,
    filesDone: !env.FILES,
    engineDone: !(engineConfigured(env) || agentConfigured(env)),
    agentDone: !agentConfigured(env),
    attempts: 0,
    nextAtMs: 0,
  };
}

// Runs whatever is left, once. Engine counts as done only when it reports
// the generation it moved to, at or past Channels' new one.
export async function advanceDelete(
  env: Env,
  p: PendingDelete,
  fetchFn?: typeof fetch,
  deleteFiles?: () => Promise<unknown>,
): Promise<{ pending: PendingDelete; engineRemoved: Record<string, number | boolean> | null }> {
  let filesDone = p.filesDone;
  if (!filesDone && deleteFiles) {
    filesDone = await deleteFiles().then(
      () => true,
      () => false,
    );
  }
  let engineRemoved: Record<string, number | boolean> | null = null;
  let engineDone = p.engineDone;
  if (!engineDone && engineConfigured(env)) {
    engineRemoved = await deleteConversationInEngine({
      engineUrl: env.MANO_ENGINE_URL!,
      channelsToken: env.MANO_ENGINE_CHANNELS_TOKEN!,
      grantSecret: env.MANO_HANDLE_GRANT_SECRET!,
      handleHash: p.handleHash,
      generation: p.generation,
      fetchFn,
    }).catch(() => null);
    engineDone = typeof engineRemoved?.generation === "number" && engineRemoved.generation >= p.generation;
  }
  let agentDone = p.agentDone;
  if (!agentDone && agentConfigured(env)) {
    agentDone = await notifyAgentDeleted({
      agentUrl: env.AGENT_URL!,
      secret: env.MANO_AGENT_SECRET!,
      grantSecret: env.MANO_HANDLE_GRANT_SECRET!,
      handleHash: p.handleHash,
      generation: p.generation,
      fetchFn,
    }).catch(() => false);
  }
  return { pending: { ...p, filesDone, engineDone, agentDone }, engineRemoved };
}

export function isDone(p: PendingDelete): boolean {
  return p.filesDone && p.engineDone && p.agentDone;
}
