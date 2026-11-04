// What a person reads for a recipient ID, the same table as
// packages/protocol/src/recipients.ts (a test holds the two equal). The
// app keeps its own copy so the bundle does not pull in the protocol's
// signing code. An ID with no name never shows as itself.

const RECIPIENT_NAMES: Record<string, string> = {
  "sandbox-agency-portal": "the State Benefits Renewal Office test portal",
  "mano-test-fax-line": "the Mano test fax line",
  "mano-practice-mailbox": "a practice mailbox where nothing is really mailed",
  "org:sandbox-county": "the Sandbox County Human Services test office",
};

export const UNNAMED_RECIPIENT = "an office Mano has no name for";

export function recipientName(id: string): string {
  return Object.prototype.hasOwnProperty.call(RECIPIENT_NAMES, id) ? (RECIPIENT_NAMES[id] as string) : UNNAMED_RECIPIENT;
}

export const RECIPIENT_TABLE: Readonly<Record<string, string>> = RECIPIENT_NAMES;
