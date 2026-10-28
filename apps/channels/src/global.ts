// Global channel state: the reconcile cursor and the daily model spend.
// One singleton row, in its own Durable Object in the worker and in
// memory in tests. Spend is reserved before the model call and settled
// after, so concurrent conversations cannot overshoot the budget.
import { DEFAULT_DAILY_BUDGET_USD, GLOBAL_BYTES_DAILY, dayKeyFor } from "@mano/channels";

export interface GlobalStateRow {
  cursor: string | null;
  spendDay: string;
  spentUsd: number;
  byteDay: string;
  bytesUsed: number;
}

export interface SpendReservation {
  key: string;
  worstUsd: number;
  day: string;
}

export interface ByteReservation {
  key: string;
  bytes: number;
  day: string;
}

export function defaultGlobalState(): GlobalStateRow {
  return { cursor: null, spendDay: "", spentUsd: 0, byteDay: "", bytesUsed: 0 };
}

// Feed event IDs remembered as already enqueued. Bounded: older pages
// fall out and would requeue, but the conversation event log dedupes
// them.
export const SEEN_IDS_CAP = 500;

export interface GlobalStore {
  state(): GlobalStateRow;
  save(state: GlobalStateRow): void;
  spendReservations(day: string): SpendReservation[];
  reserveSpend(reservation: SpendReservation): void;
  // Records actual spend exactly once per key: a repeated settlement
  // (lost response, retried turn) does not double-count.
  settleSpend(key: string, day: string, actualUsd: number): void;
  // Drops a hold without recording spend, for turns that never ran.
  releaseSpend(key: string): void;
  pruneSpendReservations(day: string): void;
  byteReservations(day: string): ByteReservation[];
  reserveBytes(reservation: ByteReservation): void;
  settleBytes(key: string, day: string, actualBytes: number): void;
  releaseBytes(key: string): void;
  pruneByteReservations(day: string): void;
  // Hashed chat ID to owning handle hash, so delivery receipts that
  // name no recipient still reach their conversation. Keys are hashes:
  // a 1:1 chat ID can itself be a phone number.
  noteRoute(chatHash: string, handleHash: string): void;
  routeFor(chatHash: string): string | null;
  // Handle hash to person ID, so account deletion finds every
  // conversation a person owns. Returns true when the bind is new.
  notePersonBind(handleHash: string, personId: string): boolean;
  handlesForPerson(personId: string): string[];
  clearPerson(personId: string): void;
  // High-watermark of feed event IDs already enqueued, so a page the
  // provider serves again (no next cursor) is not requeued.
  filterUnseen(ids: string[]): string[];
  noteSeen(ids: string[]): void;
}

export class MemoryGlobalStore implements GlobalStore {
  private row: GlobalStateRow = defaultGlobalState();
  private held = new Map<string, SpendReservation>();
  private heldBytes = new Map<string, ByteReservation>();
  private settledSpend = new Map<string, string>();
  private settledBytes = new Map<string, string>();

  state(): GlobalStateRow {
    return { ...this.row };
  }

  save(state: GlobalStateRow): void {
    this.row = { ...state };
  }

  spendReservations(day: string): SpendReservation[] {
    return [...this.held.values()].filter((r) => r.day === day);
  }

  reserveSpend(reservation: SpendReservation): void {
    this.held.set(reservation.key, { ...reservation });
  }

  settleSpend(key: string, day: string, actualUsd: number): void {
    this.held.delete(key);
    if (this.settledSpend.has(key)) return;
    this.settledSpend.set(key, day);
    const state = this.state();
    if (state.spendDay === day) {
      state.spentUsd += actualUsd;
      this.save(state);
    } else {
      state.spendDay = day;
      state.spentUsd = actualUsd;
      this.save(state);
    }
  }

  releaseSpend(key: string): void {
    this.held.delete(key);
  }

  pruneSpendReservations(day: string): void {
    for (const [key, reservation] of this.held) {
      if (reservation.day !== day) this.held.delete(key);
    }
    for (const [key, settledDay] of this.settledSpend) {
      if (settledDay !== day) this.settledSpend.delete(key);
    }
  }

  byteReservations(day: string): ByteReservation[] {
    return [...this.heldBytes.values()].filter((r) => r.day === day);
  }

  reserveBytes(reservation: ByteReservation): void {
    this.heldBytes.set(reservation.key, { ...reservation });
  }

  settleBytes(key: string, day: string, actualBytes: number): void {
    this.heldBytes.delete(key);
    if (this.settledBytes.has(key)) return;
    this.settledBytes.set(key, day);
    const state = this.state();
    if (state.byteDay === day) {
      state.bytesUsed += actualBytes;
      this.save(state);
    } else {
      state.byteDay = day;
      state.bytesUsed = actualBytes;
      this.save(state);
    }
  }

  releaseBytes(key: string): void {
    this.heldBytes.delete(key);
  }

  pruneByteReservations(day: string): void {
    for (const [key, reservation] of this.heldBytes) {
      if (reservation.day !== day) this.heldBytes.delete(key);
    }
    for (const [key, settledDay] of this.settledBytes) {
      if (settledDay !== day) this.settledBytes.delete(key);
    }
  }

  private routes = new Map<string, string>();

  noteRoute(chatHash: string, handleHash: string): void {
    this.routes.set(chatHash, handleHash);
  }

  routeFor(chatHash: string): string | null {
    return this.routes.get(chatHash) ?? null;
  }

  private personBinds = new Map<string, string>();

  notePersonBind(handleHash: string, personId: string): boolean {
    if (this.personBinds.get(handleHash) === personId) return false;
    this.personBinds.set(handleHash, personId);
    return true;
  }

  handlesForPerson(personId: string): string[] {
    const out: string[] = [];
    for (const [handleHash, bound] of this.personBinds) {
      if (bound === personId) out.push(handleHash);
    }
    return out;
  }

  clearPerson(personId: string): void {
    for (const [handleHash, bound] of this.personBinds) {
      if (bound === personId) this.personBinds.delete(handleHash);
    }
  }

  private seen: Set<string> = new Set();

  filterUnseen(ids: string[]): string[] {
    return ids.filter((id) => !this.seen.has(id));
  }

  noteSeen(ids: string[]): void {
    for (const id of ids) this.seen.add(id);
    while (this.seen.size > SEEN_IDS_CAP) {
      const oldest = this.seen.values().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

export class GlobalLedger {
  private store: GlobalStore;
  private nowMs: () => number;
  private budgetUsd: number;
  private byteBudget: number;

  constructor(
    store: GlobalStore,
    nowMs: () => number,
    budgetUsd: number = DEFAULT_DAILY_BUDGET_USD,
    byteBudget: number = GLOBAL_BYTES_DAILY,
  ) {
    this.store = store;
    this.nowMs = nowMs;
    this.budgetUsd = budgetUsd;
    this.byteBudget = byteBudget;
  }

  // Reserves the worst-case cost under a turn key. Idempotent: reusing a
  // key returns allowed without holding twice.
  reserve(key: string, worstUsd: number): { allowed: boolean; spentUsd: number } {
    const today = dayKeyFor(this.nowMs());
    this.rollDay(today);
    this.store.pruneSpendReservations(today);
    const held = this.store.spendReservations(today);
    if (held.some((r) => r.key === key)) {
      return { allowed: true, spentUsd: this.store.state().spentUsd };
    }
    const committed = this.store.state().spentUsd + held.reduce((sum, r) => sum + r.worstUsd, 0);
    if (committed + worstUsd > this.budgetUsd) {
      return { allowed: false, spentUsd: this.store.state().spentUsd };
    }
    this.store.reserveSpend({ key, worstUsd, day: today });
    return { allowed: true, spentUsd: this.store.state().spentUsd };
  }

  // Settles actual spend against a reservation, releasing the hold.
  // Settling an unknown key still records the spend. Settling a key
  // twice records it once.
  settle(key: string, actualUsd: number): { spentUsd: number } {
    const today = dayKeyFor(this.nowMs());
    this.rollDay(today);
    this.store.settleSpend(key, today, actualUsd);
    return { spentUsd: this.store.state().spentUsd };
  }

  // Releases a hold without recording spend, for turns that errored
  // before their outcome was known. The retry reserves again.
  release(key: string): void {
    this.rollDay(dayKeyFor(this.nowMs()));
    this.store.releaseSpend(key);
  }

  spent(): { spentUsd: number; budgetUsd: number } {
    const today = dayKeyFor(this.nowMs());
    this.rollDay(today);
    return { spentUsd: this.store.state().spentUsd, budgetUsd: this.budgetUsd };
  }

  // Byte reservations work like spend reservations: hold the worst case
  // before downloading, settle the actual size after.
  byteReserve(key: string, bytes: number): { allowed: boolean; bytesUsed: number } {
    const today = dayKeyFor(this.nowMs());
    this.rollByteDay(today);
    this.store.pruneByteReservations(today);
    const held = this.store.byteReservations(today);
    if (held.some((r) => r.key === key)) {
      return { allowed: true, bytesUsed: this.store.state().bytesUsed };
    }
    const committed = this.store.state().bytesUsed + held.reduce((sum, r) => sum + r.bytes, 0);
    if (committed + bytes > this.byteBudget) {
      return { allowed: false, bytesUsed: this.store.state().bytesUsed };
    }
    this.store.reserveBytes({ key, bytes, day: today });
    return { allowed: true, bytesUsed: this.store.state().bytesUsed };
  }

  byteSettle(key: string, actualBytes: number): { bytesUsed: number } {
    const today = dayKeyFor(this.nowMs());
    this.rollByteDay(today);
    this.store.settleBytes(key, today, actualBytes);
    return { bytesUsed: this.store.state().bytesUsed };
  }

  byteRelease(key: string): void {
    this.rollByteDay(dayKeyFor(this.nowMs()));
    this.store.releaseBytes(key);
  }

  noteRoute(chatHash: string, handleHash: string): void {
    this.store.noteRoute(chatHash, handleHash);
  }

  routeFor(chatHash: string): string | null {
    return this.store.routeFor(chatHash);
  }

  notePersonBind(handleHash: string, personId: string): boolean {
    return this.store.notePersonBind(handleHash, personId);
  }

  handlesForPerson(personId: string): string[] {
    return this.store.handlesForPerson(personId);
  }

  clearPerson(personId: string): void {
    this.store.clearPerson(personId);
  }

  filterUnseen(ids: string[]): string[] {
    return this.store.filterUnseen(ids);
  }

  noteSeen(ids: string[]): void {
    this.store.noteSeen(ids);
  }

  cursor(): string | null {
    return this.store.state().cursor;
  }

  saveCursor(cursor: string | null): void {
    const state = this.store.state();
    state.cursor = cursor;
    this.store.save(state);
  }

  private rollDay(today: string): void {
    const state = this.store.state();
    if (state.spendDay !== today) {
      state.spendDay = today;
      state.spentUsd = 0;
      this.store.save(state);
    }
  }

  private rollByteDay(today: string): void {
    const state = this.store.state();
    if (state.byteDay !== today) {
      state.byteDay = today;
      state.bytesUsed = 0;
      this.store.save(state);
    }
  }
}
