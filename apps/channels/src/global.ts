// Global channel state: the reconcile cursor and the daily model spend.
// One singleton row, in its own Durable Object in the worker and in
// memory in tests.
import { DEFAULT_DAILY_BUDGET_USD, budgetAllows, dayKeyFor } from "@mano/channels";

export interface GlobalStateRow {
  cursor: string | null;
  spendDay: string;
  spentUsd: number;
}

export function defaultGlobalState(): GlobalStateRow {
  return { cursor: null, spendDay: "", spentUsd: 0 };
}

export interface GlobalStore {
  state(): GlobalStateRow;
  save(state: GlobalStateRow): void;
}

export class MemoryGlobalStore implements GlobalStore {
  private row: GlobalStateRow = defaultGlobalState();

  state(): GlobalStateRow {
    return { ...this.row };
  }

  save(state: GlobalStateRow): void {
    this.row = { ...state };
  }
}

export class GlobalLedger {
  private store: GlobalStore;
  private nowMs: () => number;
  private budgetUsd: number;

  constructor(store: GlobalStore, nowMs: () => number, budgetUsd: number = DEFAULT_DAILY_BUDGET_USD) {
    this.store = store;
    this.nowMs = nowMs;
    this.budgetUsd = budgetUsd;
  }

  check(estimateUsd: number): { allowed: boolean; spentUsd: number } {
    const state = this.current();
    return { allowed: budgetAllows(state.spentUsd, estimateUsd, this.budgetUsd), spentUsd: state.spentUsd };
  }

  record(usd: number): { spentUsd: number } {
    const state = this.current();
    state.spentUsd += usd;
    this.store.save(state);
    return { spentUsd: state.spentUsd };
  }

  cursor(): string | null {
    return this.store.state().cursor;
  }

  saveCursor(cursor: string | null): void {
    const state = this.store.state();
    state.cursor = cursor;
    this.store.save(state);
  }

  private current(): GlobalStateRow {
    const state = this.store.state();
    const today = dayKeyFor(this.nowMs());
    if (state.spendDay !== today) {
      state.spendDay = today;
      state.spentUsd = 0;
      this.store.save(state);
    }
    return state;
  }
}
