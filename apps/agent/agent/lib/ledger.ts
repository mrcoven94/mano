// The turn ledger: each signed turn ID runs once. A replay of a finished
// turn gets the stored answer; a duplicate while the turn runs is turned
// away; a turn whose run went silent (a crash) can be taken over by one
// later attempt, which keeps the first receive time so the tools derive
// the same keys as the first run.
import type { KeyValue } from "./storage.js";

export interface TurnResponse {
  httpStatus: number;
  body: { status: string; text: string; reason?: string };
}

type TurnRecord =
  | { state: "running"; handleHash: string; attempt: number; receivedAtMs: number; startedAtMs: number }
  | { state: "done"; handleHash: string; receivedAtMs: number; response: TurnResponse };

export type Claim =
  | { kind: "run"; receivedAtMs: number; attempt: number }
  | { kind: "replay"; response: TurnResponse }
  | { kind: "busy" }
  | { kind: "conflict" };

// Longer than the 90s settle timeout plus Channels' own timeout, so a
// live run is never taken over.
export const RUNNING_STALE_MS = 150_000;
const RECORD_TTL_MS = 24 * 3600_000;

function turnKey(turnId: string): string {
  return `mano:turn:${turnId}`;
}

export async function claimTurn(kv: KeyValue, turnId: string, handleHash: string, nowMs: number): Promise<Claim> {
  const key = turnKey(turnId);
  const fresh: TurnRecord = { state: "running", handleHash, attempt: 1, receivedAtMs: nowMs, startedAtMs: nowMs };
  if (await kv.putIfAbsent(key, fresh, RECORD_TTL_MS)) return { kind: "run", receivedAtMs: nowMs, attempt: 1 };
  const existing = await kv.get<TurnRecord>(key);
  if (!existing) return { kind: "busy" };
  if (existing.handleHash !== handleHash) return { kind: "conflict" };
  if (existing.state === "done") return { kind: "replay", response: existing.response };
  if (nowMs - existing.startedAtMs < RUNNING_STALE_MS) return { kind: "busy" };
  const attempt = existing.attempt + 1;
  if (!(await kv.putIfAbsent(`${key}:attempt:${attempt}`, true, RECORD_TTL_MS))) return { kind: "busy" };
  await kv.put(key, { ...existing, attempt, startedAtMs: nowMs }, RECORD_TTL_MS);
  return { kind: "run", receivedAtMs: existing.receivedAtMs, attempt };
}

export async function finishTurn(
  kv: KeyValue,
  turnId: string,
  handleHash: string,
  receivedAtMs: number,
  response: TurnResponse,
): Promise<void> {
  const record: TurnRecord = { state: "done", handleHash, receivedAtMs, response };
  await kv.put(turnKey(turnId), record, RECORD_TTL_MS);
}

// A run that definitely did nothing further (it failed, not timed out)
// releases its claim so Channels' retry can run the turn again.
export async function releaseTurn(kv: KeyValue, turnId: string): Promise<void> {
  await kv.delete(turnKey(turnId));
}
