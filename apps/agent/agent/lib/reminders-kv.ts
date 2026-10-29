// KV-backed reminder store for production. One hash per reminder plus
// a sorted set of unsent IDs scored by due time, so the dispatcher
// claims due rows without scanning.
import { CLAIM_TTL_MS, type Reminder, type ReminderStore } from "./reminders.js";
import type { RedisLike } from "./storage.js";

const KEY_PREFIX = "mano:reminder:";
const DUE_KEY = "mano:reminders:due";

function rowKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function toRow(value: Record<string, unknown>): Reminder | null {
  if (
    typeof value.id !== "string" ||
    typeof value.handleHash !== "string" ||
    typeof value.text !== "string" ||
    typeof value.dueAtMs !== "number" ||
    typeof value.createdAtMs !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    handleHash: value.handleHash,
    text: value.text,
    dueAtMs: value.dueAtMs,
    createdAtMs: value.createdAtMs,
    claimedAtMs: typeof value.claimedAtMs === "number" ? value.claimedAtMs : null,
    sentAtMs: typeof value.sentAtMs === "number" ? value.sentAtMs : null,
  };
}

export class KvReminderStore implements ReminderStore {
  constructor(private kv: RedisLike) {}

  async create(reminder: Reminder): Promise<Reminder> {
    const raw = await this.kv.hgetall(rowKey(reminder.id));
    const existing = raw ? toRow(raw) : null;
    if (existing) return existing;
    await this.kv.hset(rowKey(reminder.id), { ...reminder });
    if (reminder.sentAtMs === null) {
      await this.kv.zadd(DUE_KEY, { score: reminder.dueAtMs, member: reminder.id });
    }
    return reminder;
  }

  async claimDue(nowMs: number, limit: number): Promise<Reminder[]> {
    const claimed: Reminder[] = [];
    // Over-read: some candidates may be claimed, sent, or gone.
    const candidates = await this.kv.zrange(DUE_KEY, 0, limit * 4 - 1);
    for (const id of candidates) {
      if (claimed.length >= limit) break;
      const raw = await this.kv.hgetall(rowKey(id));
      const row = raw ? toRow(raw) : null;
      if (!row || row.sentAtMs !== null) {
        if (!row || row.sentAtMs !== null) await this.kv.zrem(DUE_KEY, id);
        continue;
      }
      if (row.dueAtMs > nowMs) continue;
      if (row.claimedAtMs !== null && nowMs - row.claimedAtMs < CLAIM_TTL_MS) continue;
      const next = { ...row, claimedAtMs: nowMs };
      await this.kv.hset(rowKey(id), { ...next });
      claimed.push(next);
    }
    return claimed;
  }

  async markSent(id: string, nowMs: number): Promise<void> {
    const raw = await this.kv.hgetall(rowKey(id));
    const row = raw ? toRow(raw) : null;
    if (row) await this.kv.hset(rowKey(id), { ...row, sentAtMs: nowMs });
    await this.kv.zrem(DUE_KEY, id);
  }

  async releaseClaim(id: string): Promise<void> {
    const raw = await this.kv.hgetall(rowKey(id));
    const row = raw ? toRow(raw) : null;
    if (row && row.sentAtMs === null) await this.kv.hset(rowKey(id), { ...row, claimedAtMs: null });
  }

  async listForHandle(handleHash: string): Promise<Reminder[]> {
    // Small per-person lists: scan the due set and filter. Reminder
    // volume per handle stays tiny (a handful of rows).
    const ids = await this.kv.zrange(DUE_KEY, 0, 999);
    const out: Reminder[] = [];
    for (const id of ids) {
      const raw = await this.kv.hgetall(rowKey(id));
      const row = raw ? toRow(raw) : null;
      if (row && row.handleHash === handleHash && row.sentAtMs === null) out.push(row);
    }
    return out.sort((a, b) => a.dueAtMs - b.dueAtMs);
  }

  async cancel(id: string, handleHash: string): Promise<boolean> {
    const raw = await this.kv.hgetall(rowKey(id));
    const row = raw ? toRow(raw) : null;
    if (!row || row.handleHash !== handleHash || row.sentAtMs !== null) return false;
    await this.kv.del(rowKey(id));
    await this.kv.zrem(DUE_KEY, id);
    return true;
  }
}
