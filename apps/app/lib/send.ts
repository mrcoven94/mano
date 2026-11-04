// The one way out for a message: every message goes through the outbox
// in order, each carrying the operation ID assigned before its first
// attempt. An expired session throws before anything is queued, and an
// auth failure mid-flush drops the failed item and rethrows so the
// caller signs out instead of stranding mail for the next resident.
//
// A message naming a crisis gets 988 and 911 on the device first, before
// anything that can stop it: a held send ahead of it, no network, an
// expired session. The line is also kept for the sign-in screen, in case a
// sign-out takes this screen away first.

import { crisisGate, crisisLineFor } from "@mano/persona/crisis";
import { deviceCrisisId } from "./chat-thread";
import { noteCrisisLine } from "./crisis-help";
import { AuthError, type ChatMessage, type ManoClient, type NewAttachment, type Session } from "./api/types";
import type { Outbox, QueuedMessage } from "./queue";

// One send of one queued message: started, answered, or not answered.
export type SendPhase = "sending" | "sent" | "failed";
export type SendWatcher = (item: QueuedMessage, phase: SendPhase) => void;

export interface SubmitReport {
  opId: string;
  sent: string[];
  kept: string[];
  held: string[];
}

export function sessionUsable(session: Session, nowMs = Date.now()): boolean {
  return new Date(session.expiresAt).getTime() > nowMs;
}

export async function submitMessage(
  client: ManoClient,
  session: Session,
  outbox: Outbox,
  text: string,
  attachments: NewAttachment[],
  onReply?: (reply: ChatMessage) => void,
  watch?: SendWatcher,
): Promise<SubmitReport> {
  if (crisisGate(text) !== "none") {
    // It shows before the message is queued but reads after it.
    const createdAt = new Date(Date.now() + 1000).toISOString();
    const line = crisisLineFor(text);
    noteCrisisLine(line, Date.now());
    onReply?.({ id: deviceCrisisId(createdAt), role: "agent", text: line, createdAt, attachments: [], status: "sent" });
  }
  if (!sessionUsable(session)) throw new AuthError();
  const item = await outbox.enqueue(session.personId, text, attachments);
  const report = await outbox.flush(session, async (queued) => {
    await sendWatched(client, session, queued, onReply, watch);
  });
  return { opId: item.id, sent: report.sent, kept: report.kept, held: report.held };
}

// Every send out of the outbox, so a screen hears how each one went
// whichever flush carried it.
export async function sendWatched(
  client: ManoClient,
  session: Session,
  item: QueuedMessage,
  onReply?: (reply: ChatMessage) => void,
  watch?: SendWatcher,
): Promise<void> {
  watch?.(item, "sending");
  let reply: ChatMessage;
  try {
    reply = await client.sendMessage(session, item.text, item.attachments, item.id);
  } catch (err) {
    watch?.(item, "failed");
    throw err;
  }
  onReply?.(reply);
  watch?.(item, "sent");
}
