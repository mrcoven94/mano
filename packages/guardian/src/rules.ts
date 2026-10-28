import type { CheckInput, CheckResult, Checker } from "./types.js";

const ACTION_TYPES: ReadonlySet<string> = new Set([
  "send",
  "submit",
  "call",
  "fax",
  "share",
]);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Claims the checker must find in the cited sources. Callers put checkable
// statements in one of these shapes; anything else carries no claims.
function extractClaims(payload: unknown): string[] {
  if (typeof payload === "string") {
    const claim = payload.trim();
    return claim ? [claim] : [];
  }
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
  }
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record["claims"])) {
      return (record["claims"] as unknown[]).filter(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      );
    }
    if (typeof record["text"] === "string") {
      const claim = record["text"].trim();
      return claim ? [claim] : [];
    }
  }
  return [];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Local rules checker. Needs no keys and no network. Fails closed: anything
// it cannot verify is a block, never a pass.
export class RulesChecker implements Checker {
  async check(input: CheckInput): Promise<CheckResult> {
    const problems: string[] = [];
    const { action } = input;

    if (!ACTION_TYPES.has(action.type as string)) {
      problems.push(
        `Mano does not recognize this kind of action (${String(action.type)}), so it cannot go ahead.`,
      );
    }

    if (normalize(action.recipient) === "") {
      problems.push("There is no recipient for this action, so it cannot go ahead.");
    }
    if (normalize(action.purpose) === "") {
      problems.push("There is no stated purpose for this action, so it cannot go ahead.");
    }

    // A letter, web page or document is evidence, never permission.
    if (input.origin === "content") {
      problems.push(
        "This action came from something Mano read, not from the person. The person must ask for it directly.",
      );
    }

    // The recipient and purpose need a matching consent grant.
    const recipient = normalize(action.recipient);
    const purpose = normalize(action.purpose);
    const consented = input.consents.some(
      (consent) =>
        normalize(consent.recipient) === recipient &&
        normalize(consent.purpose) === purpose,
    );
    if (!consented && recipient !== "" && purpose !== "") {
      problems.push(
        `The person has not agreed to share with ${action.recipient} for ${action.purpose}.`,
      );
    }

    // Every claim in the payload needs a source that states it.
    const claims = extractClaims(action.payload);
    const quotes = input.sources
      .map((source) => normalize(source.quote ?? ""))
      .filter((quote) => quote !== "");
    for (const claim of claims) {
      const wanted = normalize(claim);
      const supported = quotes.some(
        (quote) => quote.includes(wanted) || wanted.includes(quote),
      );
      if (!supported) {
        problems.push(
          `Nothing the person shared supports this statement: "${truncate(claim.trim(), 160)}"`,
        );
      }
    }

    if (problems.length > 0) {
      return { verdict: "block", problems };
    }
    return { verdict: "pass", problems: [] };
  }
}
