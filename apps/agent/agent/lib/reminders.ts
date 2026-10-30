// Reminders: "remind me Friday" and deadline nudges. Engine keeps them in
// the person's own record and its alarm delivers each due one as a text
// through Channels, under the Channels deletion generation it was set in.
// Claim and cancel are single guarded steps in Engine, so a cancelled
// reminder is never sent and one already on its way is never reported as
// cancelled.
import { createHash } from "node:crypto";

export const REMINDER_PREFIX = "Reminder: ";

// A reminder's identity comes from the signed turn, its due time (which
// a retry derives the same way, from the turn's first receive time) and
// its place among this attempt's reminders due at that same time. The
// wording never counts, so a retry that rewords a reminder lands on the
// one it already made. The place is claimed in Engine's turn ledger per
// attempt (Eve turn), atomically, so two different reminders for the
// same time in one model step get places 0 and 1 even when their calls
// run in parallel, and a retry claims them again from 0.
export function reminderBase(turnId: string, dueAtMs: number): string {
  return `rem-${createHash("sha256").update(`${turnId}\n${dueAtMs}`).digest("hex").slice(0, 32)}`;
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
