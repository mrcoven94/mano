// Date display in the person's language. Deadlines show a short date
// plus a day count; nothing fancy, nothing ambiguous.

import type { Language } from "./strings";

export function formatDate(iso: string, language: Language): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language === "es" ? "es" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function daysUntil(iso: string, nowMs = Date.now()): number {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 0;
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  return Math.round((startOfDay(at) - startOfDay(nowMs)) / (24 * 3600_000));
}
