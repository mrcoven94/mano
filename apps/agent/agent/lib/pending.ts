// The one approval question waiting on a person, as a pointer to
// Engine's approval. Engine owns the frozen request, its hash, expiry and
// execution; the agent keeps only which approval its last question was
// about, so a texted YES or NO reaches exactly that approval. The
// question is rendered from the request Engine froze, so the person reads
// the exact content their yes would send.
import type { EngineApproval } from "./engine.js";
import type { KeyValue } from "./storage.js";

export interface PendingApproval {
  approvalId: string;
  personId: string;
  // The turn that proposed it, so that turn's reply carries the question.
  turnId: string;
  purpose: string;
  question: string;
}

const LABELS: Record<string, string> = {
  fullName: "Name",
  dateOfBirth: "Date of birth",
  address: "Address",
  phone: "Phone",
  householdSize: "Household size",
  monthlyIncome: "Monthly income",
};

const MAX_TTL_MS = 24 * 3600_000;

function pendingKey(personId: string): string {
  return `mano:pending:${personId}`;
}

export function renderQuestion(approval: EngineApproval): string {
  let payload: Record<string, unknown> = {};
  try {
    const frozen = JSON.parse(approval.requestJson) as { payload?: Record<string, unknown> };
    payload = frozen.payload ?? {};
  } catch {
    // Unreadable frozen request: the question shows purpose and recipient only.
  }
  const lines = Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${LABELS[k] ?? k}: ${v}`);
  return [
    `Ready to send: ${approval.purpose} (to ${approval.recipient}).`,
    ...lines,
    "Reply YES to send exactly this, or NO to stop.",
  ].join("\n");
}

export async function savePending(kv: KeyValue, pending: PendingApproval, expiresAt: string): Promise<void> {
  const ttlMs = Math.min(MAX_TTL_MS, Math.max(60_000, new Date(expiresAt).getTime() - Date.now()));
  await kv.put(pendingKey(pending.personId), pending, Number.isFinite(ttlMs) ? ttlMs : MAX_TTL_MS);
}

export function loadPending(kv: KeyValue, personId: string): Promise<PendingApproval | null> {
  return kv.get<PendingApproval>(pendingKey(personId));
}

export function clearPending(kv: KeyValue, personId: string): Promise<void> {
  return kv.delete(pendingKey(personId));
}
