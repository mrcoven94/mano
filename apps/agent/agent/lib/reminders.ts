// Reminders: "remind me Friday" and deadline nudges. Engine keeps them in
// the person's own record and its alarm delivers each due one as a text
// through Channels, under the Channels deletion generation it was set in.
// Claim and cancel are single guarded steps in Engine, so a cancelled
// reminder is never sent and one already on its way is never reported as
// cancelled.
import { createHash } from "node:crypto";

import { parseWhen } from "./when.js";

export const REMINDER_PREFIX = "Reminder: ";

// A reminder's identity comes from the signed turn, the time the person
// asked for before any zone applies (lib/when.ts, ParsedWhen.asked) and
// its place among this attempt's reminders asked for that same time. A
// retry derives the time the same way, from the turn's first receive
// time, and a retry that reads a different zone from the profile still
// names the same reminder; Engine then returns the one already saved.
// The reminder's wording never counts, so a retry that rewords it lands
// on the one it already made. The place is claimed in Engine's turn
// ledger per attempt (Eve turn), atomically, so two different reminders
// for the same time in one model step get places 0 and 1 even when their
// calls run in parallel, and a retry claims them again from 0.
export function reminderBase(turnId: string, asked: string): string {
  return `rem-${createHash("sha256").update(`${turnId}\n${asked}`).digest("hex").slice(0, 32)}`;
}

// Before LAP-813 a reminder was named by its due time, read in
// MANO_TIMEZONE (Denver by default). A turn received before that change
// shipped and retried after it finds its reminder under the old name.
// Turns received after LEGACY_IDS_UNTIL_MS skip the check; remove it then.
export const LEGACY_IDS_UNTIL_MS = Date.UTC(2026, 10, 12);

export function legacyReminderId(turnId: string, when: string, turnAtMs: number): string | null {
  if (turnAtMs >= LEGACY_IDS_UNTIL_MS) return null;
  const old = parseWhen(when, turnAtMs, process.env.MANO_TIMEZONE || "America/Denver");
  return old ? `rem-${createHash("sha256").update(`${turnId}\n${old.dueAtMs}`).digest("hex").slice(0, 32)}` : null;
}

export function reminderIdAt(base: string, place: number): string {
  return place === 0 ? base : `${base}-${place}`;
}

export function placeClaimId(base: string, attempt: string, place: number): string {
  return `p-${createHash("sha256").update(`${base}\n${attempt}`).digest("hex").slice(0, 40)}-${place}`;
}

export function sameWords(a: string, b: string): boolean {
  const words = (t: string) => t.replace(REMINDER_PREFIX, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return words(a) === words(b);
}
