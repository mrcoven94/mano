// Reminders: "remind me Friday" and deadline nudges. Engine keeps them in
// the person's own record and its alarm delivers each due one as a text
// through Channels, under the Channels deletion generation it was set in.
// Claim and cancel are single guarded steps in Engine, so a cancelled
// reminder is never sent and one already on its way is never reported as
// cancelled.
import { createHash } from "node:crypto";

export const REMINDER_PREFIX = "Reminder: ";

// One reminder per turn, due time and wording: a replayed or recovered
// turn derives the same ID, so it finds the reminder it already made,
// while two different reminders set for the same time stay two. Case,
// spacing and punctuation do not change the identity.
export function reminderIdFor(turnId: string, dueAtMs: number, text: string): string {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `rem-${createHash("sha256").update(`${turnId}\n${dueAtMs}\n${words}`).digest("hex").slice(0, 32)}`;
}
