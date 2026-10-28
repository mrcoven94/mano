// Cost and abuse limits for a public number. Pure checks over stored
// counters; the worker owns the counters.

export const HANDLE_HOURLY_LIMIT = 20;
export const HANDLE_DAILY_LIMIT = 100;
export const TURN_TEXT_CAP = 4000;
// Buffered inbound per conversation. A handle texting nonstop keeps
// postponing the batch alarm; the cap bounds what waits for it.
export const MAX_PENDING_CHARS = 8000;
export const DEFAULT_DAILY_BUDGET_USD = 5;
export const DEFAULT_USD_PER_1K_CHARS = 0.001;
export const MAX_ATTACHMENTS_PER_TURN = 5;
export const MAX_ATTACHMENT_BYTES = 10_000_000;
export const HANDLE_BYTES_DAILY = 25_000_000;
export const GLOBAL_BYTES_DAILY = 500_000_000;
export const ATTACHMENT_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface HandleWindows {
  hourKey: string;
  hourCount: number;
  dayKey: string;
  dayCount: number;
}

export function hourKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

export function dayKeyFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function handleOverLimit(windows: HandleWindows, nowMs: number): "hour" | "day" | null {
  if (windows.hourKey === hourKeyFor(nowMs) && windows.hourCount >= HANDLE_HOURLY_LIMIT) return "hour";
  if (windows.dayKey === dayKeyFor(nowMs) && windows.dayCount >= HANDLE_DAILY_LIMIT) return "day";
  return null;
}

export function estimateCostUsd(inputChars: number, outputChars: number, usdPer1kChars: number): number {
  return ((inputChars + outputChars) / 1000) * usdPer1kChars;
}

export function budgetAllows(spentUsd: number, estimateUsd: number, budgetUsd: number): boolean {
  return spentUsd + estimateUsd <= budgetUsd;
}
