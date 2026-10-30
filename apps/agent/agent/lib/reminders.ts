// Reminders: "remind me Friday" and deadline nudges. Engine keeps them in
// the person's own record and its alarm delivers each due one as a text
// through Channels, under the Channels deletion generation it was set in.
// Claim and cancel are single guarded steps in Engine, so a cancelled
// reminder is never sent and one already on its way is never reported as
// cancelled.
import { createHash } from "node:crypto";

export const REMINDER_PREFIX = "Reminder: ";

// A reminder's identity is the turn plus its ordinal among this turn's
// remind calls, never its wording. A retried turn (Channels sends the same
// signed turn again) starts counting from zero again, so its first
// reminder is the first attempt's first reminder whatever the model says
// this time; Engine then returns the reminder it already holds.
export function reminderIdFor(turnId: string, ordinal: number): string {
  return `rem-${createHash("sha256").update(`${turnId}\n${ordinal}`).digest("hex").slice(0, 32)}`;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

// How many calls to this tool the current attempt made before this one:
// tool calls in the model input after the attempt's own message (the last
// person message). The input excludes the step that requested this call,
// so the tool asks the model to set reminders one call at a time.
export function ordinalInTurn(messages: readonly unknown[], toolName: string): number {
  const list = messages as readonly MessageLike[];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }
  let count = 0;
  for (const message of list.slice(start)) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: unknown; toolName?: unknown }[]) {
      if (part?.type === "tool-call" && part.toolName === toolName) count += 1;
    }
  }
  return count;
}
