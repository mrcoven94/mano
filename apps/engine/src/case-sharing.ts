// Sharing a case, on the person's side: what they shared, with which
// organization, what that organization asked for and what they sent back.
// Rows are per organization and case, so stopping with one organization
// says nothing about another. Stopping is final for that organization and
// case; sharing again later opens a new case, so nothing old comes back.
// The organization's own copy of these facts lives in its OrgAgent; both
// sides refuse on their own.
//
// A document grant is one approved document: the hash the person's yes
// covered, in the conversation it was sent in. Deleting the conversation
// ends every grant and closes every open request. The organization then
// keeps the case with the values the person approved, until they stop
// sharing, and a private record of which documents it was sent. Mano cannot
// recall what its staff already saved, and says so in a text after the
// person's next message (Channels forgets how to reach them in the delete,
// so it cannot be sooner).
import { ANY_RECIPIENT, recipientName } from "@mano/protocol";

import { createReminder, currentGeneration } from "./agents/agent-state.js";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[]; rowsWritten: number };
}

// What an organization may ask for, by the words Mano texts. A closed list:
// staff typing never reaches the person's phone, so a request can carry no
// link or instruction.
export const DOCUMENT_KINDS: Readonly<Record<string, string>> = {
  "pay-stub": "pay stub",
  "proof-of-address": "proof of address",
  "photo-id": "photo ID",
  "bank-statement": "bank statement",
  "rent-receipt": "rent receipt",
};

export function documentKindLabel(kind: unknown): string | null {
  return typeof kind === "string" && Object.hasOwn(DOCUMENT_KINDS, kind) ? DOCUMENT_KINDS[kind] : null;
}

// A reminder row delivers each text, so it gets retries, its one send and
// Channels' answer. Each organization chooses its own request IDs, so the ID
// names the organization too. Reminders the person set are listed without
// these.
const REQUEST_REMINDER_PREFIX = "case-request:";
const NOTICE_REMINDER_PREFIX = "case-share-notice:";
const MAX_NOTICE_KEYS = 3;

export function isShareReminder(id: string): boolean {
  return id.startsWith(REQUEST_REMINDER_PREFIX) || id.startsWith(NOTICE_REMINDER_PREFIX);
}

export function requestReminderId(recipient: string, requestId: string): string {
  return `${REQUEST_REMINDER_PREFIX}${recipient}:${requestId}`;
}

// Stops a closed request's text from ever going again. One already handed
// to Channels and waiting on a retry is withdrawn, as a stopped deadline's
// nudge is: only a send already in Channels' hands can still land, and
// Channels dedupes it.
function withdrawText(sql: SqlExec, match: "id = ?" | "id LIKE ?", value: string, nowMs: number): void {
  sql.exec(
    "UPDATE reminders SET status = CASE WHEN status = 'sending' THEN 'withdrawn' ELSE 'cancelled' END, finished_at_ms = ?" +
      ` WHERE ${match} AND status IN ('scheduled', 'claimed', 'sending')`,
    nowMs, value,
  );
}

function withdrawRequestText(sql: SqlExec, recipient: string, requestId: string, nowMs: number): void {
  withdrawText(sql, "id = ?", requestReminderId(recipient, requestId), nowMs);
}

export function documentRequestText(recipient: string, purpose: string, label: string): string {
  const name = recipientName(recipient);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} asked for your ${label} for ${purpose}. Send a photo of it here and I will check with you before it goes to them.`;
}

export function ensureCaseSharingTables(sql: SqlExec): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS consents(recipient TEXT NOT NULL, case_id TEXT NOT NULL, purpose TEXT NOT NULL, expires_at_ms INTEGER, PRIMARY KEY (recipient, case_id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS revoked_shares(recipient TEXT NOT NULL, case_id TEXT NOT NULL, revoked_at TEXT NOT NULL, PRIMARY KEY (recipient, case_id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS document_requests(recipient TEXT NOT NULL, id TEXT NOT NULL, case_id TEXT NOT NULL, document_kind TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, PRIMARY KEY (recipient, id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS shared_documents(recipient TEXT NOT NULL, case_id TEXT NOT NULL, document_id TEXT NOT NULL, hash TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY (recipient, case_id, document_id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS share_delete_notices(generation INTEGER PRIMARY KEY)`);
}

// Revocations recorded before they were per organization name only the
// case. A revoke's stored outbound message names the organization, and is
// stored before delivery, so only one whose effect was applied counts: a
// failed revoke to another organization leaves its message behind too.
export function migrateRevokedCases(sql: SqlExec): void {
  if (sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revoked_cases'").toArray().length === 0) return;
  const revoked = new Map(
    (sql.exec("SELECT case_id, revoked_at FROM revoked_cases").toArray() as { case_id: string; revoked_at: string }[]).map((r) => [r.case_id, r.revoked_at]),
  );
  const placed = new Set<string>();
  const applied = "SELECT message_json FROM outbound_consent WHERE idempotency_key IN (SELECT idempotency_key FROM applied_effects)";
  for (const row of sql.exec(applied).toArray() as { message_json: string }[]) {
    let message: { type?: string; caseId?: string; toAgentId?: string };
    try {
      message = JSON.parse(row.message_json) as typeof message;
    } catch {
      continue;
    }
    const at = message.caseId ? revoked.get(message.caseId) : undefined;
    if (message.type === "consent.revoke" && at && message.toAgentId) {
      sql.exec("INSERT OR IGNORE INTO revoked_shares VALUES (?, ?, ?)", message.toAgentId, message.caseId, at);
      placed.add(message.caseId!);
    }
  }
  for (const [caseId, at] of revoked) {
    if (!placed.has(caseId)) sql.exec("INSERT OR IGNORE INTO revoked_shares VALUES (?, ?, ?)", ANY_RECIPIENT, caseId, at);
  }
  sql.exec("DROP TABLE revoked_cases");
}

// Whether a grant may go out. An old revocation the migration could not
// place stays in force for every organization.
export function shareRevoked(sql: SqlExec, recipient: string, caseId: string): boolean {
  return sql.exec("SELECT 1 FROM revoked_shares WHERE recipient IN (?, ?) AND case_id = ?", recipient, ANY_RECIPIENT, caseId).toArray().length > 0;
}

export function shareActive(sql: SqlExec, recipient: string, caseId: string, nowMs: number): boolean {
  if (shareRevoked(sql, recipient, caseId)) return false;
  return (
    sql.exec(
      "SELECT 1 FROM consents WHERE recipient = ? AND case_id = ? AND (expires_at_ms IS NULL OR expires_at_ms > ?)",
      recipient, caseId, nowMs,
    ).toArray().length > 0
  );
}

// The documents an organization may read on a case, with the hash each
// approval covered: the stored document must still be the approved one, in
// the current conversation.
export function readableDocuments(sql: SqlExec, recipient: string, caseId: string): { documentId: string; hash: string }[] {
  const rows = sql.exec(
    "SELECT g.document_id, g.hash FROM shared_documents g JOIN documents d ON d.id = g.document_id AND d.hash = g.hash AND d.generation = g.generation" +
      " WHERE g.recipient = ? AND g.case_id = ? AND g.generation = ?",
    recipient, caseId, currentGeneration(sql),
  ).toArray() as { document_id: string; hash: string }[];
  return rows.map((r) => ({ documentId: r.document_id, hash: r.hash }));
}

interface ShareRequest {
  consent?: string;
  caseId?: string;
  expiresAt?: string;
  requestId?: string;
}

// The approved action's effect on the person's records. Runs inside the
// transaction that records the action's receipt, at most once per key: a
// SQL error rolls the whole of it back. approvalCurrent is false when a
// conversation delete came between the person's yes and this outcome.
export function applyShareOutcome(
  sql: SqlExec,
  approval: { recipient: string; purpose: string; requestJson: string; documentHash: string | null; documentId: string | null },
  nowMs: number,
  approvalCurrent: boolean,
): void {
  let stored: { payload?: ShareRequest };
  try {
    stored = JSON.parse(approval.requestJson) as typeof stored;
  } catch {
    // Approval JSON is written by the gateway; an unreadable row has no effect to apply.
    return;
  }
  const payload = stored.payload;
  const caseId = payload?.caseId;
  if (typeof caseId !== "string" || !caseId) return;
  const { recipient } = approval;
  if (payload?.consent === "grant") {
    // This organization's own revocation wins: it recorded that too, so a
    // grant whose response was lost and that reconciles after it never
    // restores anything. Any other way, the organization holds this grant,
    // so it goes on the record, where the person can stop it.
    if (sql.exec("SELECT 1 FROM revoked_shares WHERE recipient = ? AND case_id = ?", recipient, caseId).toArray().length > 0) return;
    // Parsed to epoch milliseconds at write time; an unreadable value
    // fails closed as already expired.
    const raw = payload.expiresAt;
    const expiresAtMs = typeof raw === "string" && Number.isFinite(new Date(raw).getTime())
      ? new Date(raw).getTime()
      : raw === undefined
        ? null
        : 0;
    sql.exec("INSERT OR REPLACE INTO consents(recipient, case_id, purpose, expires_at_ms) VALUES (?, ?, ?, ?)", recipient, caseId, approval.purpose, expiresAtMs);
    // The office has it after all, though the delete found nothing shared.
    if (!approvalCurrent) oweDeleteNotice(sql);
  } else if (payload?.consent === "revoke") {
    sql.exec("DELETE FROM consents WHERE recipient = ? AND case_id = ?", recipient, caseId);
    sql.exec("INSERT OR IGNORE INTO revoked_shares VALUES (?, ?, ?)", recipient, caseId, new Date(nowMs).toISOString());
    const open = sql.exec("SELECT id FROM document_requests WHERE recipient = ? AND case_id = ? AND status = 'open'", recipient, caseId).toArray() as { id: string }[];
    sql.exec("UPDATE document_requests SET status = 'closed' WHERE recipient = ? AND case_id = ? AND status = 'open'", recipient, caseId);
    for (const { id } of open) withdrawRequestText(sql, recipient, id, nowMs);
    withdrawText(sql, "id LIKE ?", `${NOTICE_REMINDER_PREFIX}%`, nowMs);
  } else if (payload?.consent === "provide") {
    // A yes from before a delete opens nothing, even if the same bytes are back.
    if (approvalCurrent) grantDocument(sql, recipient, caseId, approval);
    const requestId = payload.requestId ?? "";
    sql.exec("UPDATE document_requests SET status = 'provided' WHERE recipient = ? AND id = ? AND status = 'open'", recipient, requestId);
    withdrawRequestText(sql, recipient, requestId, nowMs);
  }
}

// Only while the document on file is the one the yes covered. A delete that
// landed while it was on its way already removed it, so no grant is written.
function grantDocument(sql: SqlExec, recipient: string, caseId: string, approval: { documentHash: string | null; documentId: string | null }): void {
  const { documentHash, documentId } = approval;
  if (!documentHash || !documentId) return;
  const generation = currentGeneration(sql);
  const onFile = sql.exec("SELECT 1 FROM documents WHERE id = ? AND hash = ? AND generation = ?", documentId, documentHash, generation).toArray();
  if (onFile.length === 0) return;
  sql.exec("INSERT OR REPLACE INTO shared_documents(recipient, case_id, document_id, hash, generation) VALUES (?, ?, ?, ?, ?)", recipient, caseId, documentId, documentHash, generation);
}

// A conversation delete, in its own transaction, when the generation moved:
// the documents are gone, so every grant goes, and what was waiting on one
// closes. A notice waits for the person's next text when an organization
// still holds what they approved.
export function endDocumentAccess(sql: SqlExec, nowMs: number): void {
  sql.exec("DELETE FROM shared_documents");
  sql.exec("UPDATE document_requests SET status = 'closed' WHERE status = 'open'");
  if (listShares(sql, nowMs).active.length > 0) oweDeleteNotice(sql);
}

function oweDeleteNotice(sql: SqlExec): void {
  sql.exec("INSERT OR IGNORE INTO share_delete_notices(generation) VALUES (?)", currentGeneration(sql));
}

// Channels forgets how to reach a person in a delete and learns again from
// their next message, so that is when the notice goes. It stays owed until
// Channels says it sent one: a text waiting on a retry is left to finish,
// and one with no answer goes again under its own key, so Channels dedupes it
// if the text did go. Only a refusal, which sent nothing, takes a new key, and
// a conversation gets at most MAX_NOTICE_KEYS. True when this queued one.
export function queueDeleteNotice(sql: SqlExec, nowMs: number): boolean {
  const generation = currentGeneration(sql);
  if (sql.exec("SELECT 1 FROM share_delete_notices WHERE generation = ?", generation).toArray().length === 0) return false;
  const prefix = `${NOTICE_REMINDER_PREFIX}${generation}:`;
  const tries = sql.exec("SELECT id, status FROM reminders WHERE id LIKE ? ORDER BY id", `${prefix}%`).toArray() as { id: string; status: string }[];
  if (tries.some((t) => ["sent", "scheduled", "claimed", "sending"].includes(t.status))) return false;
  const { active } = listShares(sql, nowMs);
  if (active.length === 0) return false;
  const last = tries.at(-1);
  if (last?.status === "failed") {
    sql.exec(
      "UPDATE reminders SET status = 'scheduled', next_at_ms = ?, attempts = 0, claim_token = NULL, claimed_at_ms = NULL, finished_at_ms = NULL WHERE id = ?",
      nowMs, last.id,
    );
    return true;
  }
  if (tries.length >= MAX_NOTICE_KEYS) return false;
  const offices = active.map((s) => {
    const name = recipientName(s.recipient);
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} can no longer open the documents you sent, but it still has the details you approved for ${s.purpose}.`;
  });
  const text = `Your history with Mano was deleted. ${offices.join(" ")} Mano cannot recall those or anything the office already saved. Say stop sharing to end its access to those details.`;
  createReminder(sql, { id: `${prefix}${tries.length}`, text, dueAtMs: nowMs, generation }, nowMs);
  return true;
}

// One row per request: true only for the delivery that recorded it, so a
// redelivered request texts nobody twice.
export function recordDocumentRequest(
  sql: SqlExec,
  input: { recipient: string; id: string; caseId: string; documentKind: string; requestedAt: string },
): boolean {
  return (
    sql.exec(
      "INSERT OR IGNORE INTO document_requests(recipient, id, case_id, document_kind, status, requested_at) VALUES (?, ?, ?, ?, 'open', ?)",
      input.recipient, input.id, input.caseId, input.documentKind, input.requestedAt,
    ).rowsWritten > 0
  );
}

export interface ShareList {
  active: {
    recipient: string;
    caseId: string;
    purpose: string;
    openRequests: { id: string; documentKind: string; label: string; requestedAt: string }[];
  }[];
  revoked: { recipient: string; caseId: string }[];
}

export function listShares(sql: SqlExec, nowMs: number): ShareList {
  const revoked = (sql.exec("SELECT recipient, case_id FROM revoked_shares").toArray() as { recipient: string; case_id: string }[]).map((r) => ({
    recipient: r.recipient,
    caseId: r.case_id,
  }));
  const consents = sql.exec(
    "SELECT recipient, case_id, purpose FROM consents WHERE expires_at_ms IS NULL OR expires_at_ms > ? ORDER BY case_id",
    nowMs,
  ).toArray() as { recipient: string; case_id: string; purpose: string }[];
  const requests = sql.exec("SELECT recipient, id, case_id, document_kind, requested_at FROM document_requests WHERE status = 'open' ORDER BY requested_at").toArray() as {
    recipient: string;
    id: string;
    case_id: string;
    document_kind: string;
    requested_at: string;
  }[];
  return {
    revoked,
    active: consents.map((c) => ({
      recipient: c.recipient,
      caseId: c.case_id,
      purpose: c.purpose,
      openRequests: requests
        .filter((r) => r.recipient === c.recipient && r.case_id === c.case_id)
        .map((r) => ({ id: r.id, documentKind: r.document_kind, label: documentKindLabel(r.document_kind) ?? "document", requestedAt: r.requested_at })),
    })),
  };
}
