import type { SourceCitation } from "@mano/protocol";
import type { ActionRequest, ActionType, ActorKind } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const ACTION_TYPES = ["send", "submit", "call", "fax", "share"] as const;
const ACTION_TYPE_SET: ReadonlySet<string> = new Set(ACTION_TYPES);
const SOURCE_KINDS: ReadonlySet<string> = new Set(["document", "message", "profile", "program"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string.`);
  }
  if (value.length > max) throw new ValidationError(`${field} is too long.`);
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, max);
}

function parseSources(value: unknown): SourceCitation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("sources must be an array.");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new ValidationError("Each source must be an object.");
    if (typeof entry.kind !== "string" || !SOURCE_KINDS.has(entry.kind)) {
      throw new ValidationError("Each source needs a known kind.");
    }
    const source: SourceCitation = {
      kind: entry.kind as SourceCitation["kind"],
      id: requiredString(entry.id, "source id", 500),
    };
    const quote = optionalString(entry.quote, "source quote", 2000);
    if (quote !== undefined) source.quote = quote;
    return source;
  });
}

// Validates untrusted input into an ActionRequest. Builds a fresh object and
// never spreads caller input, so prototype names ("toString", "__proto__")
// cannot smuggle properties or match policy entries.
export function parseActionRequest(raw: unknown): ActionRequest {
  if (!isRecord(raw)) throw new ValidationError("Action request must be an object.");
  if (typeof raw.type !== "string" || !ACTION_TYPE_SET.has(raw.type)) {
    throw new ValidationError("Unknown action type.");
  }
  const actor = raw.actor as ActorKind;
  if (actor !== "foreground" && actor !== "background") {
    throw new ValidationError("actor must be foreground or background.");
  }
  if (!isRecord(raw.payload)) throw new ValidationError("payload must be an object.");
  const origin = raw.origin;
  if (origin !== undefined && origin !== "person" && origin !== "content") {
    throw new ValidationError("origin must be person or content.");
  }
  const req: ActionRequest = {
    type: raw.type as ActionType,
    recipient: requiredString(raw.recipient, "recipient", 500),
    purpose: requiredString(raw.purpose, "purpose", 2000),
    // Plain-JSON clone: drops functions and keeps __proto__ keys as inert data.
    payload: JSON.parse(JSON.stringify(raw.payload)) as Record<string, unknown>,
    idempotencyKey: requiredString(raw.idempotencyKey, "idempotencyKey", 200),
    actor,
    personId: requiredString(raw.personId, "personId", 200),
    sources: parseSources(raw.sources),
    origin: (origin ?? "person") as ActionRequest["origin"],
  };
  const documentId = optionalString(raw.documentId, "documentId", 200);
  if (documentId !== undefined) req.documentId = documentId;
  // documentContent from the caller is ignored: bytes come from storage.
  const caseId = optionalString(raw.caseId, "caseId", 200);
  if (caseId !== undefined) req.caseId = caseId;
  const deadlineAt = optionalString(raw.deadlineAt, "deadlineAt", 100);
  if (deadlineAt !== undefined) req.deadlineAt = deadlineAt;
  return req;
}
