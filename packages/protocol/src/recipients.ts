// What a person reads for each recipient ID: the one place an action's
// recipient becomes words, for the approval question and every page.
// Each name reads inside a sentence ("to the ..."), so it carries its own
// article. Names stay synthetic or generic until a partner agrees in
// writing to be named.
export const RECIPIENT_NAMES = {
  // Our own fake portal, named the way it names itself.
  "sandbox-agency-portal": "the State Benefits Renewal Office test portal",
  // Rule 2: the only places a fax or a letter can go for now.
  "mano-test-fax-line": "the Mano test fax line",
  "mano-practice-mailbox": "a practice mailbox where nothing is really mailed",
} as const;

export type RecipientId = keyof typeof RECIPIENT_NAMES;

// An ID with no name never shows as itself: an internal ID tells the
// person nothing, and saying the office is unnamed lets them say no.
export const UNNAMED_RECIPIENT = "an office Mano has no name for";

export function recipientName(id: string): string {
  return Object.hasOwn(RECIPIENT_NAMES, id) ? RECIPIENT_NAMES[id as RecipientId] : UNNAMED_RECIPIENT;
}
