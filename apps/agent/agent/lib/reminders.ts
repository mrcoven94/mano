// Reminders: "remind me Friday" and deadline nudges. The remind tool
// writes a row; the dispatcher schedule fires every minute and delivers
// each due row as a text through Channels' internal route. Rows carry
// the hashed handle only, never a phone number.
//
// Sending and cancelling race, so both go through two markers whose
// writes are atomic on their own: beginSend sets "sending" if absent and
// then checks "cancelled"; cancel sets "cancelled" and then checks
// "sending". Whichever wrote second sees the other, so a reminder is
// never both reported cancelled and sent. beginSend runs right before
// each delivery, never for a whole batch ahead of time.
import { createHash } from "node:crypto";

export interface Reminder {
  id: string;
  handleHash: string;
  // Channels' deletion generation when the reminder was set; Channels
  // refuses delivery once the conversation has been deleted since.
  generation: number;
  text: string;
  dueAtMs: number;
  createdAtMs: number;
  sentAtMs: number | null;
}

// How long a send claim lasts. A crash mid-delivery leaves the claim to
// expire so a later run retries; Channels dedupes on the reminder ID.
export const CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_REMINDER_TEXT_CHARS = 500;

export type CancelOutcome = "cancelled" | "sending" | "not_found";

export interface ReminderStore {
  // Saves the row unless one with the same ID exists, and returns the
  // stored row either way, so a repeated save converges on one reminder.
  create(reminder: Reminder): Promise<Reminder>;
  // IDs of unsent rows due at or before nowMs, oldest first. Only a
  // candidate list: beginSend decides.
  dueIds(nowMs: number, limit: number): Promise<string[]>;
  // Claims one row for delivery right now, or null when it is gone,
  // sent, cancelled or claimed by another run.
  beginSend(id: string, nowMs: number): Promise<Reminder | null>;
  markSent(id: string, nowMs: number): Promise<void>;
  releaseSend(id: string): Promise<void>;
  listForHandle(handleHash: string): Promise<Reminder[]>;
  cancel(id: string, handleHash: string): Promise<CancelOutcome>;
}

// One reminder per turn, due time and wording: a replayed or recovered
// turn derives the same ID, so it finds the row it already made, while
// two different reminders set for the same time stay two rows. Case,
// spacing and punctuation do not change the identity.
export function reminderIdFor(turnId: string, dueAtMs: number, text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `rem_${createHash("sha256").update(`${turnId}\n${dueAtMs}\n${words}`).digest("hex").slice(0, 24)}`;
}

// In-memory store for local dev and tests. Production uses Redis:
// Vercel instances do not share memory and the filesystem is ephemeral.
export class MemoryReminderStore implements ReminderStore {
  private rows = new Map<string, Reminder>();
  private sendingUntil = new Map<string, number>();
  private cancelled = new Set<string>();

  async create(reminder: Reminder): Promise<Reminder> {
    const existing = this.rows.get(reminder.id);
    if (existing) return { ...existing };
    this.rows.set(reminder.id, { ...reminder });
    return { ...reminder };
  }

  async dueIds(nowMs: number, limit: number): Promise<string[]> {
    return [...this.rows.values()]
      .filter((r) => r.sentAtMs === null && r.dueAtMs <= nowMs)
      .sort((a, b) => a.dueAtMs - b.dueAtMs)
      .slice(0, limit)
      .map((r) => r.id);
  }

  async beginSend(id: string, nowMs: number): Promise<Reminder | null> {
    const row = this.rows.get(id);
    if (!row || row.sentAtMs !== null || row.dueAtMs > nowMs) return null;
    if ((this.sendingUntil.get(id) ?? 0) > nowMs) return null;
    this.sendingUntil.set(id, nowMs + CLAIM_TTL_MS);
    if (this.cancelled.has(id)) return null;
    return { ...row };
  }

  async markSent(id: string, nowMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, sentAtMs: nowMs });
  }

  async releaseSend(id: string): Promise<void> {
    this.sendingUntil.delete(id);
  }

  async listForHandle(handleHash: string): Promise<Reminder[]> {
    return [...this.rows.values()]
      .filter((r) => r.handleHash === handleHash && r.sentAtMs === null && !this.cancelled.has(r.id))
      .sort((a, b) => a.dueAtMs - b.dueAtMs)
      .map((r) => ({ ...r }));
  }

  async cancel(id: string, handleHash: string): Promise<CancelOutcome> {
    const row = this.rows.get(id);
    if (!row || row.handleHash !== handleHash || row.sentAtMs !== null || this.cancelled.has(id)) return "not_found";
    this.cancelled.add(id);
    if ((this.sendingUntil.get(id) ?? 0) > Date.now()) return "sending";
    this.rows.delete(id);
    return "cancelled";
  }
}
