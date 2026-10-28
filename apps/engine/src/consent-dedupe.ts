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

// Whether a consent event was recorded under an idempotency key.
// Reconcile reads this record, never the dedupe marker: a marker can
// survive a crash that the event did not.
export function consentEventRecorded(sql: SqlExec, idempotencyKey: string): boolean {
  const rows = sql.exec(
    "SELECT id FROM case_events WHERE idempotency_key = ? LIMIT 1",
    idempotencyKey,
  ).toArray();
  return rows.length > 0;
}

export type DeliveryApply = "applied" | "duplicate" | "unavailable";

// Records a delivery and appends its consent event in one transaction,
// so a revoke is never marked done before it happens. The transaction
// runner is injected because Durable Objects forbid SQL BEGIN: callers
// pass storage.transactionSync (which rolls back on throw). A duplicate
// marker with no event (a crash landed between the writes, or a legacy
// row) falls through and appends the missing event instead of reporting
// done. Any failure rolls back and reports unavailable.
export function applyConsentDelivery(
  sql: SqlExec,
  fromAgentId: string,
  idempotencyKey: string,
  append: () => void,
  transact: <T>(fn: () => T) => T,
): DeliveryApply {
  try {
    return transact(() => {
      if (
        tryRecordDelivery(sql, fromAgentId, idempotencyKey) === "duplicate" &&
        consentEventRecorded(sql, idempotencyKey)
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
