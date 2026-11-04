// Consent delivery dedupe. Insert-first with ON CONFLICT DO NOTHING
// RETURNING: a returned row means this call recorded the delivery, an
// empty result means a concurrent delivery recorded the same sender and
// key first. Any other storage error throws through as unavailable and
// must never read as a duplicate or a success.

export type DeliveryRecord = "recorded" | "duplicate";

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

export function tryRecordDelivery(
  sql: SqlExec,
  fromAgentId: string,
  idempotencyKey: string,
): DeliveryRecord {
  const rows = sql.exec(
    "INSERT INTO processed_messages VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING idempotency_key",
    fromAgentId,
    idempotencyKey,
  ).toArray();
  return rows.length > 0 ? "recorded" : "duplicate";
}

// The resident behind a sender agent ID. Person agents send as
// person:<id>; anything else matches literally.
export function senderPerson(fromAgentId: string): string {
  return fromAgentId.startsWith("person:") ? fromAgentId.slice("person:".length) : fromAgentId;
}

export type ConsentEventType = "share" | "revoke";

// A delivery's full scope. Keys are caller-controlled, so two people
// (or a grant and a revoke) can share one; the person and the event
// type tell deliveries apart. The organization is scoped structurally:
// each org agent answers only from its own tables.
export interface DeliveryScope {
  fromAgentId: string;
  idempotencyKey: string;
  event: ConsentEventType;
}

// Whether this sender's event of this type was recorded under a key.
// Reconcile reads this record, never the dedupe marker and never a
// key alone: a marker can survive a crash that the event did not, and
// another sender's event under the same key must not satisfy this one.
export function consentEventRecorded(sql: SqlExec, scope: DeliveryScope): boolean {
  const rows = sql.exec(
    "SELECT id FROM case_events WHERE idempotency_key = ? AND person_id = ? AND event = ? LIMIT 1",
    scope.idempotencyKey,
    senderPerson(scope.fromAgentId),
    scope.event,
  ).toArray();
  return rows.length > 0;
}

export type DeliveryApply = "applied" | "duplicate" | "unavailable";

// Records a delivery and appends its consent event in one transaction,
// so a revoke is never marked done before it happens. The transaction
// runner is injected because Durable Objects forbid SQL BEGIN: callers
// pass storage.transactionSync (which rolls back on throw). A duplicate
// marker with no matching event (a crash landed between the writes, a
// legacy row, or a foreign delivery under the same key) falls through
// and appends the missing event instead of reporting done. Any failure
// rolls back and reports unavailable.
export function applyConsentDelivery(
  sql: SqlExec,
  scope: DeliveryScope,
  append: () => void,
  transact: <T>(fn: () => T) => T,
): DeliveryApply {
  try {
    return transact(() => {
      if (
        tryRecordDelivery(sql, scope.fromAgentId, scope.idempotencyKey) === "duplicate" &&
        consentEventRecorded(sql, scope)
      ) {
        return "duplicate" as const;
      }
      append();
      return "applied" as const;
    });
  } catch {
    return "unavailable";
  }
}
