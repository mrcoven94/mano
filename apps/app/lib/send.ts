// The one way out for a message: every message goes through the outbox
// in order, each carrying the operation ID assigned before its first
// attempt. An expired session throws before anything is queued, and an
// auth failure mid-flush drops the failed item and rethrows so the
// caller signs out instead of stranding mail for the next resident.

import { AuthError, type ManoClient, type NewAttachment, type Session } from "./api/types";
import type { Outbox } from "./queue";

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
): Promise<SubmitReport> {
  if (!sessionUsable(session)) throw new AuthError();
  const item = await outbox.enqueue(session.personId, text, attachments);
  const report = await outbox.flush(session, (queued) =>
    client.sendMessage(session, queued.text, queued.attachments, queued.id),
  );
  return { opId: item.id, sent: report.sent, kept: report.kept, held: report.held };
}
