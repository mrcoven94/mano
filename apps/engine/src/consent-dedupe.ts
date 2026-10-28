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
