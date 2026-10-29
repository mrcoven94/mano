export const messageSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://withmano.com/protocol/message.schema.json",
  type: "object",
  required: [
    "id",
    "version",
    "type",
    "caseId",
    "fromAgentId",
    "toAgentId",
    "payload",
    "sources",
    "approvedByHumanId",
    "idempotencyKey",
    "createdAt",
    "signature",
    "signerPublicKey",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    version: { type: "number", const: 1 },
    type: {
      type: "string",
      enum: [
        "case.open",
        "document.request",
        "document.provide",
        "decision",
        "notice",
        "consent.grant",
        "consent.revoke",
      ],
    },
    caseId: { type: "string", minLength: 1 },
    fromAgentId: { type: "string", minLength: 1 },
    toAgentId: { type: "string", minLength: 1 },
    payload: { type: "object" },
    sources: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "id"],
        properties: {
          kind: { type: "string", enum: ["document", "message", "profile", "program"] },
          id: { type: "string" },
          quote: { type: "string" },
        },
      },
    },
    approvedByHumanId: { type: ["string", "null"] },
    idempotencyKey: { type: "string", minLength: 1 },
    createdAt: { type: "string" },
    signature: { type: "string", minLength: 1 },
    signerPublicKey: { type: "string", minLength: 1 },
  },
} as const;

export const schemasByType: Record<string, object> = {
  "case.open": {
    type: "object",
    required: ["personId", "programId", "purpose", "synthetic"],
    properties: {
      personId: { type: "string" },
      programId: { type: "string" },
      purpose: { type: "string" },
      synthetic: { type: "boolean" },
    },
  },
  "document.request": {
    type: "object",
    required: ["documentKind", "reason"],
    properties: {
      documentKind: { type: "string" },
      reason: { type: "string" },
      dueAt: { type: "string" },
    },
  },
  "document.provide": {
    type: "object",
    required: ["documentId", "documentHash", "r2Key"],
    properties: {
      documentId: { type: "string" },
      documentHash: { type: "string" },
      r2Key: { type: "string" },
    },
  },
  decision: {
    type: "object",
    required: ["outcome", "reason", "decidedByHumanId"],
    properties: {
      outcome: { type: "string", enum: ["approved", "denied", "needs_info"] },
      reason: { type: "string" },
      decidedByHumanId: { type: "string" },
    },
  },
  notice: {
    type: "object",
    required: ["text", "channel"],
    properties: {
      text: { type: "string" },
      channel: { type: "string", enum: ["web", "sms", "email", "fax"] },
    },
  },
  "consent.grant": {
    type: "object",
    required: ["orgAgentId", "purpose", "scope"],
    properties: {
      orgAgentId: { type: "string" },
      purpose: { type: "string" },
      scope: { type: "array", items: { type: "string" } },
      expiresAt: { type: "string" },
    },
  },
  "consent.revoke": {
    type: "object",
    required: ["orgAgentId"],
    properties: { orgAgentId: { type: "string" }, note: { type: "string" } },
  },
};

interface MiniSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, MiniSchema>;
  enum?: unknown[];
  items?: MiniSchema;
  minLength?: number;
}

// Small validator for the payload schemas above: required, type, enum,
// minLength and array items. Deliberately narrow; unknown keywords fail.
function matches(value: unknown, schema: MiniSchema): boolean {
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "string":
      return (
        typeof value === "string" &&
        (schema.minLength === undefined || value.length >= schema.minLength)
      );
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        (schema.items === undefined || value.every((entry) => matches(entry, schema.items as MiniSchema)))
      );
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) return false;
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (record[key] !== undefined && !matches(record[key], sub)) return false;
      }
      return true;
    }
    default:
      return schema.type === undefined;
  }
}

export function validatePayload(type: string, payload: unknown): boolean {
  const schema = (schemasByType as Record<string, MiniSchema>)[type];
  if (!schema) return false;
  return matches(payload, schema);
}
