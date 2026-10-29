// Redis-backed reminder store for production. One hash per reminder, a
// sorted set of unsent IDs scored by due time, and per-reminder
// "sending" and "cancelled" markers set with single atomic writes (see
// reminders.ts for why the pair is race-free).
import { CLAIM_TTL_MS, type CancelOutcome, type Reminder, type ReminderStore } from "./reminders.js";
import type { RedisLike } from "./storage.js";

const KEY_PREFIX = "mano:reminder:";
const DUE_KEY = "mano:reminders:due";

// Outlives any due reminder a person could still cancel.
const CANCEL_MARK_TTL_MS = 400 * 24 * 3600_000;

function rowKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function sendingKey(id: string): string {
  return `${KEY_PREFIX}${id}:sending`;
}

function cancelledKey(id: string): string {
  return `${KEY_PREFIX}${id}:cancelled`;
}

function toRow(value: Record<string, unknown>): Reminder | null {
  if (
    typeof value.id !== "string" ||
    typeof value.handleHash !== "string" ||
    typeof value.text !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.dueAtMs !== "number" ||
    typeof value.createdAtMs !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    handleHash: value.handleHash,
    generation: value.generation,
    text: value.text,
    dueAtMs: value.dueAtMs,
    createdAtMs: value.createdAtMs,
    sentAtMs: typeof value.sentAtMs === "number" ? value.sentAtMs : null,
  };
}

export class KvReminderStore implements ReminderStore {
  constructor(private kv: RedisLike) {}

  private async row(id: string): Promise<Reminder | null> {
    const raw = await this.kv.hgetall(rowKey(id));
    return raw ? toRow(raw) : null;
  }

  async create(reminder: Reminder): Promise<Reminder> {
    const existing = await this.row(reminder.id);
    if (existing) return existing;
    await this.kv.hset(rowKey(reminder.id), { ...reminder });
    if (reminder.sentAtMs === null) {
      await this.kv.zadd(DUE_KEY, { score: reminder.dueAtMs, member: reminder.id });
    }
    return reminder;
  }

  async dueIds(nowMs: number, limit: number): Promise<string[]> {
    const ids = await this.kv.zrange(DUE_KEY, 0, limit * 4 - 1);
    const out: string[] = [];
    for (const id of ids) {
      if (out.length >= limit) break;
      const row = await this.row(id);
      if (!row || row.sentAtMs !== null) {
        await this.kv.zrem(DUE_KEY, id);
        continue;
      }
      if (row.dueAtMs <= nowMs) out.push(id);
    }
    return out;
  }

  async beginSend(id: string, nowMs: number): Promise<Reminder | null> {
    const row = await this.row(id);
    if (!row || row.sentAtMs !== null || row.dueAtMs > nowMs) return null;
    const claimed = await this.kv.set(sendingKey(id), nowMs, { nx: true, px: CLAIM_TTL_MS });
    if (claimed === null) return null;
    if ((await this.kv.get(cancelledKey(id))) !== null) {
      await this.kv.zrem(DUE_KEY, id);
      return null;
    }
    return row;
  }

  async markSent(id: string, nowMs: number): Promise<void> {
    const row = await this.row(id);
    if (row) await this.kv.hset(rowKey(id), { ...row, sentAtMs: nowMs });
    await this.kv.zrem(DUE_KEY, id);
  }

  async releaseSend(id: string): Promise<void> {
    await this.kv.del(sendingKey(id));
  }

  async listForHandle(handleHash: string): Promise<Reminder[]> {
    // Scans the global due set (parked: a per-person index, review 1
    // finding 10). Reminder volume per handle stays a handful of rows.
    const ids = await this.kv.zrange(DUE_KEY, 0, 999);
    const out: Reminder[] = [];
    for (const id of ids) {
      const row = await this.row(id);
      if (row && row.handleHash === handleHash && row.sentAtMs === null) out.push(row);
    }
    return out.sort((a, b) => a.dueAtMs - b.dueAtMs);
  }

  async cancel(id: string, handleHash: string): Promise<CancelOutcome> {
    const row = await this.row(id);
    if (!row || row.handleHash !== handleHash || row.sentAtMs !== null) return "not_found";
    await this.kv.set(cancelledKey(id), 1, { px: CANCEL_MARK_TTL_MS });
    await this.kv.zrem(DUE_KEY, id);
    if ((await this.kv.get(sendingKey(id))) !== null) return "sending";
    await this.kv.del(rowKey(id));
    return "cancelled";
  }
}
