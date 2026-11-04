// The words the approval card leads with, and how an answer's value is
// written, kept apart from the screen so tests can hold them.

import type { ActionField, KnownAction } from "./action-view";
import type { ActionType } from "./api/types";
import { UNNAMED_RECIPIENT } from "./recipients";
import type { Language, Strings } from "./strings";

// The declaration every form ends with (apps/agent/agent/lib/pending.ts
// reads the same sentence). Known, so its meaning can be said before the
// frozen English.
const PERJURY = /^I declare under penalty of perjury that the information in this .+ is true, correct and complete to the best of my knowledge\.$/;

// What kind of action this is, for a card or a row.
export function whatLabel(action: ActionType, s: Strings): string {
  if (action === "submit") return s.whatSubmit;
  if (action === "send") return s.whatSend;
  if (action === "share") return s.whatShare;
  if (action === "call") return s.whatCall;
  if (action === "mail") return s.whatMail;
  return s.whatFax;
}

// An office's name is frozen with the request. The line for an office with
// no name is the app's own, so it follows the person.
export function officeName(recipientName: string, s: Strings): string {
  return recipientName === UNNAMED_RECIPIENT ? s.recipientUnnamed : recipientName;
}

// The frame above the declaration. The declaration itself stays word for
// word, since it is what the yes makes.
export function declarationIntro(declaration: string, s: Strings): string {
  return PERJURY.test(declaration) ? s.youSignPerjury : s.youSign;
}

// The purpose, the office and the document of a filed form are frozen in
// English (docs/decisions.md, November 4), so a person reading another
// language is told why. A message or a share may be in any language, so it
// makes no such claim.
export function sentInEnglishNote(action: KnownAction, language: Language, s: Strings): string | null {
  return action.kind === "submit" && language !== "en" ? s.sentInEnglish : null;
}

// What Mano will do, in the person's language. A share says which way
// access goes. The office goes on its own line: recipient names carry
// English articles, so they never sit inside a translated sentence.
export function leadLine(action: KnownAction, s: Strings): string {
  if (action.kind === "submit") return s.leadSubmit;
  if (action.kind === "send") return s.leadSend;
  if (action.kind === "call") return s.leadCall;
  if (action.kind === "fax") return s.leadFax;
  if (action.kind === "mail") return s.leadMail;
  const consent = action.answers.find((f) => f.format === "consent")?.value;
  return consent === "revoke" ? s.leadShareRevoke : s.leadShareGrant;
}

// Only the presentation changes: a plain amount gets its dollar sign
// and grouping, a calendar day its month in words, a share's grant or
// revoke its words, and a value with no words of its own gets the
// person's.
export function fieldValue(field: ActionField, s: Strings, language: Language): string {
  if (field.format === "flag") return field.value === "true" ? s.valueYes : s.valueNo;
  if (field.format === "empty") return s.valueEmpty;
  if (field.format === "unreadable") return s.valueUnreadable;
  if (field.format === "money") {
    const amount = Number(field.value);
    return new Intl.NumberFormat(language === "es" ? "es-US" : "en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  }
  if (field.format === "date") {
    // A day, not an instant: read and written in UTC so no time zone
    // moves it to the day before.
    return new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${field.value}T00:00:00Z`));
  }
  if (field.format === "consent") {
    if (field.value === "grant") return s.consentGrant;
    if (field.value === "revoke") return s.consentRevoke;
  }
  return field.value;
}
