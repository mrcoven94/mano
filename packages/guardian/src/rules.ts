import type {
  ActionType,
  CheckConsent,
  CheckInput,
  CheckResult,
  Checker,
  CheckSource,
} from "./types.js";

const ACTION_TYPES: ReadonlySet<string> = new Set([
  "send",
  "submit",
  "call",
  "fax",
  "share",
]);

const SOURCE_KINDS: ReadonlySet<string> = new Set([
  "document",
  "message",
  "profile",
  "program",
]);

function normalizeLabel(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Canonical destination for consent and destination matching. URIs keep
// their case-sensitive parts: only the scheme and the //authority are
// lowercased. Anything else is a plain label matched case-insensitively.
export function canonicalRecipient(raw: string): string {
  const text = raw.trim();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text);
  if (scheme?.[1] === undefined) {
    return text.toLowerCase().replace(/\s+/g, " ");
  }
  const rest = text.slice(scheme[1].length + 1);
  if (rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const end = afterSlashes.search(/[/?#]/);
    const authority = end === -1 ? afterSlashes : afterSlashes.slice(0, end);
    const remainder = end === -1 ? "" : afterSlashes.slice(end);
    return `${scheme[1].toLowerCase()}://${authority.toLowerCase()}${remainder}`;
  }
  return `${scheme[1].toLowerCase()}:${rest}`;
}

interface PayloadSchema {
  destinations: string[];
  content: string[];
  extra: string[];
}

export const PAYLOAD_SCHEMAS: Record<ActionType, PayloadSchema> = {
  send: { destinations: ["to"], content: ["subject", "body", "text"], extra: [] },
  submit: { destinations: [], content: ["text"], extra: ["formId"] },
  call: { destinations: [], content: ["script", "text"], extra: [] },
  fax: { destinations: ["to"], content: ["cover", "text"], extra: [] },
  share: { destinations: ["with"], content: ["text"], extra: [] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckInput(value: unknown): value is CheckInput {
  if (!isRecord(value)) return false;
  const { action, sources, consents, origin } = value;
  if (!isRecord(action)) return false;
  if (typeof action["type"] !== "string") return false;
  if (!ACTION_TYPES.has(action["type"])) return false;
  if (typeof action["recipient"] !== "string") return false;
  if (typeof action["purpose"] !== "string") return false;
  if (
    typeof action["payload"] !== "string" &&
    !Array.isArray(action["payload"]) &&
    !isRecord(action["payload"])
  ) {
    return false;
  }
  if (Array.isArray(action["payload"])) {
    if (!action["payload"].every((item) => typeof item === "string")) {
      return false;
    }
  }
  if (typeof action["documentHash"] !== "string" && action["documentHash"] !== null) {
    return false;
  }
  if (!Array.isArray(sources)) return false;
  for (const source of sources) {
    if (!isRecord(source)) return false;
    if (typeof source["kind"] !== "string" || !SOURCE_KINDS.has(source["kind"])) {
      return false;
    }
    if (typeof source["id"] !== "string") return false;
    if (source["quote"] !== undefined && typeof source["quote"] !== "string") {
      return false;
    }
  }
  if (!Array.isArray(consents)) return false;
  for (const consent of consents) {
    if (!isRecord(consent)) return false;
    if (typeof consent["recipient"] !== "string") return false;
    if (typeof consent["purpose"] !== "string") return false;
  }
  return typeof origin === "string";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function supportedBySources(claim: string, sources: CheckSource[]): boolean {
  const wanted = normalizeLabel(claim);
  if (wanted === "") return true;
  return sources.some((source) => {
    const quote = normalizeLabel(source.quote ?? "");
    return quote !== "" && quote.includes(wanted);
  });
}

// Local rules checker. Needs no keys and no network. Fails closed: anything
// it cannot verify is a block, never a pass.
export class RulesChecker implements Checker {
  async check(rawInput: CheckInput): Promise<CheckResult> {
    const problems: string[] = [];
    if (!isCheckInput(rawInput)) {
      return {
        verdict: "block",
        problems: [
          "Mano could not verify what this action is, so it cannot go ahead.",
        ],
      };
    }
    const input = rawInput;
    const { action } = input;

    if (normalizeLabel(action.recipient) === "") {
      problems.push("There is no recipient for this action, so it cannot go ahead.");
    }
    if (normalizeLabel(action.purpose) === "") {
      problems.push("There is no stated purpose for this action, so it cannot go ahead.");
    }

    // A letter, web page or document is evidence, never permission. Only the
    // person can originate an action.
    if (input.origin !== "person") {
      problems.push(
        input.origin === "content"
          ? "This action came from something Mano read, not from the person. The person must ask for it directly."
          : "Mano could not tell who asked for this action, so it cannot go ahead.",
      );
    }

    // The recipient and purpose need a matching consent grant.
    const recipient = canonicalRecipient(action.recipient);
    const purpose = normalizeLabel(action.purpose);
    const consented = input.consents.some(
      (consent: CheckConsent) =>
        canonicalRecipient(consent.recipient) === recipient &&
        normalizeLabel(consent.purpose) === purpose,
    );
    if (!consented && recipient !== "" && purpose !== "") {
      problems.push(
        `The person has not agreed to share with ${action.recipient} for ${action.purpose}.`,
      );
    }

    this.checkPayload(action.type, action.payload, action.recipient, input, problems);

    if (problems.length > 0) {
      return { verdict: "block", problems };
    }
    return { verdict: "pass", problems: [] };
  }

  private checkPayload(
    type: ActionType,
    payload: unknown,
    recipient: string,
    input: CheckInput,
    problems: string[],
  ): void {
    if (typeof payload === "string") {
      this.requireSupported([payload], input, problems);
      return;
    }
    if (Array.isArray(payload)) {
      this.requireSupported(
        payload.filter((item): item is string => typeof item === "string"),
        input,
        problems,
      );
      return;
    }
    if (!isRecord(payload)) {
      problems.push(
        "Mano does not recognize the shape of this action, so it cannot go ahead.",
      );
      return;
    }
    const schema = PAYLOAD_SCHEMAS[type];
    const known = new Set([
      "claims",
      ...schema.destinations,
      ...schema.content,
      ...schema.extra,
    ]);
    for (const key of Object.keys(payload)) {
      if (!known.has(key)) {
        problems.push(
          `Mano does not recognize the "${key}" part of this ${type} action, so it cannot go ahead.`,
        );
      }
    }

    if (payload["claims"] !== undefined) {
      if (
        !Array.isArray(payload["claims"]) ||
        !payload["claims"].every((item) => typeof item === "string")
      ) {
        problems.push(
          "The statements in this action are not in a shape Mano can check, so it cannot go ahead.",
        );
      } else {
        this.requireSupported(
          payload["claims"].filter((item): item is string => typeof item === "string"),
          input,
          problems,
        );
      }
    }

    for (const field of schema.destinations) {
      const value = payload[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(
          `The destination in this ${type} action is not usable, so it cannot go ahead.`,
        );
        continue;
      }
      if (canonicalRecipient(value) !== canonicalRecipient(recipient)) {
        problems.push(
          `This ${type} action would go to ${value}, not to the approved recipient ${recipient}.`,
        );
      }
    }

    for (const field of schema.content) {
      const value = payload[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        problems.push(
          `The "${field}" part of this ${type} action is not in a shape Mano can check, so it cannot go ahead.`,
        );
        continue;
      }
      this.requireSupported([value], input, problems);
    }

    for (const field of schema.extra) {
      const value = payload[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(
          `The "${field}" part of this ${type} action is not usable, so it cannot go ahead.`,
        );
      }
    }
  }

  private requireSupported(
    claims: string[],
    input: CheckInput,
    problems: string[],
  ): void {
    for (const claim of claims) {
      if (claim.trim() === "") continue;
      if (!supportedBySources(claim, input.sources)) {
        problems.push(
          `Nothing the person shared supports this statement: "${truncate(claim.trim(), 160)}"`,
        );
      }
    }
  }
}
