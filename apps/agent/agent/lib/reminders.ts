// Reminders: "remind me Friday" and deadline nudges. The remind tool
// writes a row; the dispatcher schedule fires every minute, claims due
// rows, and delivers each as a text through Channels' internal route.
// Rows carry the hashed handle only, never a phone number.
import { createHash } from "node:crypto";

export interface Reminder {
  id: string;
  handleHash: string;
  text: string;
  dueAtMs: number;
  createdAtMs: number;
  // Claimed by a dispatcher run; a crash before delivery leaves the
  // claim to expire so another run picks the row up again.
  claimedAtMs: number | null;
  sentAtMs: number | null;
}

export const CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_REMINDER_TEXT_CHARS = 500;

export interface ReminderStore {
  // Saves the row unless one with the same ID exists, and returns the
  // stored row either way, so a repeated save converges on one reminder.
  create(reminder: Reminder): Promise<Reminder>;
  // Atomically claims up to limit rows due at or before nowMs whose
  // claim is missing or expired and that were never sent.
  claimDue(nowMs: number, limit: number): Promise<Reminder[]>;
  markSent(id: string, nowMs: number): Promise<void>;
  releaseClaim(id: string): Promise<void>;
  listForHandle(handleHash: string): Promise<Reminder[]>;
  cancel(id: string, handleHash: string): Promise<boolean>;
}

// One reminder per turn and due time: a replayed or recovered turn
// derives the same ID, so it finds the row it already made.
export function reminderIdFor(turnId: string, dueAtMs: number): string {
  return `rem_${createHash("sha256").update(`${turnId}\n${dueAtMs}`).digest("hex").slice(0, 24)}`;
}

// In-memory store for local dev and tests. Production uses KV: Vercel
// instances do not share memory and the filesystem is ephemeral.
export class MemoryReminderStore implements ReminderStore {
  private rows = new Map<string, Reminder>();

  async create(reminder: Reminder): Promise<Reminder> {
    const existing = this.rows.get(reminder.id);
    if (existing) return { ...existing };
    this.rows.set(reminder.id, { ...reminder });
    return { ...reminder };
  }

  async claimDue(nowMs: number, limit: number): Promise<Reminder[]> {
    const claimed: Reminder[] = [];
    for (const row of [...this.rows.values()].sort((a, b) => a.dueAtMs - b.dueAtMs)) {
      if (claimed.length >= limit) break;
      if (row.sentAtMs !== null || row.dueAtMs > nowMs) continue;
      if (row.claimedAtMs !== null && nowMs - row.claimedAtMs < CLAIM_TTL_MS) continue;
      row.claimedAtMs = nowMs;
      claimed.push({ ...row });
    }
    return claimed;
  }

  async markSent(id: string, nowMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, sentAtMs: nowMs });
  }

  async releaseClaim(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.sentAtMs === null) this.rows.set(id, { ...row, claimedAtMs: null });
  }

  async listForHandle(handleHash: string): Promise<Reminder[]> {
    return [...this.rows.values()]
      .filter((r) => r.handleHash === handleHash && r.sentAtMs === null)
      .sort((a, b) => a.dueAtMs - b.dueAtMs)
      .map((r) => ({ ...r }));
  }

  async cancel(id: string, handleHash: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.handleHash !== handleHash || row.sentAtMs !== null) return false;
    this.rows.delete(id);
    return true;
  }
}
