// The words the approval card leads with, and how an answer's value is
// written, kept apart from the screen so tests can hold them.

import type { ActionField, KnownAction } from "./action-view";
import type { Language, Strings } from "./strings";

// What Mano will do, in the person's language. A share says which way
// access goes. The office goes on its own line: recipient names carry
// English articles, so they never sit inside a translated sentence.
export function leadLine(action: KnownAction, s: Strings): string {
  if (action.kind === "submit") return s.leadSubmit;
  if (action.kind === "send") return s.leadSend;
  if (action.kind === "call") return s.leadCall;
  if (action.kind === "fax") return s.leadFax;
  const consent = action.answers.find((f) => f.format === "consent")?.value;
  return consent === "revoke" ? s.leadShareRevoke : s.leadShareGrant;
}

// Only the presentation changes: a plain amount gets its dollar sign
// and grouping, a share's grant or revoke its words.
export function fieldValue(field: ActionField, s: Strings, language: Language): string {
  if (field.format === "money") {
    const amount = Number(field.value);
    return new Intl.NumberFormat(language === "es" ? "es-US" : "en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  }
  if (field.format === "consent") {
    if (field.value === "grant") return s.consentGrant;
    if (field.value === "revoke") return s.consentRevoke;
  }
  return field.value;
}
