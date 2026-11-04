import { describe, expect, it } from "vitest";
import { parseActionView, type KnownAction } from "../lib/action-view";
import { declarationIntro, fieldValue, leadLine, officeName, sentInEnglishNote, whatLabel } from "../lib/approval-text";
import { RECIPIENT_TABLE, UNNAMED_RECIPIENT, recipientName } from "../lib/recipients";
import { en, es } from "../lib/strings";
import { RECIPIENT_NAMES, UNNAMED_RECIPIENT as PROTOCOL_UNNAMED } from "../../../packages/protocol/src/recipients";

function known(type: string, payload: Record<string, unknown>): KnownAction {
  const parsed = parseActionView(JSON.stringify({ type, recipient: "r", purpose: "p", idempotencyKey: "k", payload }));
  if (parsed.kind === "unknown") throw new Error(parsed.reason);
  return parsed;
}

describe("approval card text", () => {
  it("leads with what Mano will do in the person's language", () => {
    expect(leadLine(known("submit", {}), en)).toBe(en.leadSubmit);
    expect(leadLine(known("submit", {}), es)).toBe(es.leadSubmit);
    expect(leadLine(known("send", { text: "hi" }), en)).toBe(en.leadSend);
  });

  it("says which way a share goes", () => {
    expect(leadLine(known("share", { consent: "grant", caseId: "R-1" }), en)).toBe(en.leadShareGrant);
    expect(leadLine(known("share", { consent: "revoke", caseId: "R-1" }), en)).toBe(en.leadShareRevoke);
  });

  it("writes amounts as dollars and leaves everything else as filed", () => {
    const [whole] = known("submit", { monthlyIncome: "1940" }).answers;
    const [cents] = known("submit", { monthlyIncome: "1940.5" }).answers;
    const [text] = known("submit", { monthlyIncome: "about 1900" }).answers;
    expect(fieldValue(whole!, en, "en")).toBe("$1,940");
    expect(fieldValue(cents!, en, "en")).toBe("$1,940.50");
    expect(fieldValue(text!, en, "en")).toBe("about 1900");
    const [birth] = known("submit", { dateOfBirth: "1988-03-14" }).answers;
    expect(fieldValue(birth!, en, "en")).toBe("March 14, 1988");
    expect(fieldValue(birth!, es, "es")).toBe("14 de marzo de 1988");
    const [zero] = known("submit", { dateOfBirth: "0000-01-01" }).answers;
    const [one] = known("submit", { dateOfBirth: "0001-01-01" }).answers;
    expect(fieldValue(zero!, en, "en")).toBe("0000-01-01");
    expect(fieldValue(one!, en, "en")).toBe("0001-01-01");
    const [grant] = known("share", { consent: "grant", caseId: "R-1" }).answers;
    expect(fieldValue(grant!, es, "es")).toBe(es.consentGrant);
  });

  it("gives values with no words of their own the person's words", () => {
    const answers = known("submit", { resident: true, moved: false, middleName: null }).answers;
    expect(answers.map((f) => fieldValue(f, es, "es"))).toEqual([es.valueYes, es.valueNo, es.valueEmpty]);
    expect(answers.map((f) => fieldValue(f, en, "en"))).toEqual([en.valueYes, en.valueNo, en.valueEmpty]);
    const unreadable = { key: "x", label: null, value: "", format: "unreadable" as const };
    expect(fieldValue(unreadable, es, "es")).toBe(es.valueUnreadable);
    // A word the request itself holds stays as filed.
    const [written] = known("submit", { resident: "true" }).answers;
    expect(fieldValue(written!, es, "es")).toBe("true");
  });

  it("keeps an office's own name and words the line for an office with none", () => {
    expect(officeName("the Mano test fax line", es)).toBe("the Mano test fax line");
    expect(officeName(UNNAMED_RECIPIENT, es)).toBe(es.recipientUnnamed);
    expect(officeName(UNNAMED_RECIPIENT, en)).toBe(UNNAMED_RECIPIENT);
    expect(en.recipientUnnamed).toBe(UNNAMED_RECIPIENT);
  });

  it("names each kind of action in the person's language", () => {
    expect(whatLabel("submit", es)).toBe(es.whatSubmit);
    expect(whatLabel("send", es)).toBe(es.whatSend);
    expect(whatLabel("share", es)).toBe(es.whatShare);
    expect(whatLabel("call", es)).toBe(es.whatCall);
    expect(whatLabel("mail", es)).toBe(es.whatMail);
    expect(whatLabel("fax", es)).toBe(es.whatFax);
  });

  it("says what the known declaration means before the frozen English", () => {
    const perjury = "I declare under penalty of perjury that the information in this renewal is true, correct and complete to the best of my knowledge.";
    expect(declarationIntro(perjury, es)).toBe(es.youSignPerjury);
    expect(es.youSignPerjury).toContain("bajo pena de perjurio");
    expect(declarationIntro("I agree to something else.", es)).toBe(es.youSign);
    expect(es.youSign).not.toContain("perjurio");
    expect(declarationIntro(perjury, en)).toBe(en.youSign);
  });

  it("says a filed form goes in English only to someone reading another language", () => {
    const form = known("submit", {});
    expect(sentInEnglishNote(form, "es", es)).toBe(es.sentInEnglish);
    expect(sentInEnglishNote(form, "en", en)).toBeNull();
    expect(sentInEnglishNote(known("send", { text: "hola" }), "es", es)).toBeNull();
  });
});

describe("recipient names", () => {
  it("matches the protocol's table word for word", () => {
    expect(RECIPIENT_TABLE).toEqual(RECIPIENT_NAMES);
    expect(UNNAMED_RECIPIENT).toBe(PROTOCOL_UNNAMED);
  });

  it("never shows an ID as its own name", () => {
    expect(recipientName("sandbox-agency-portal")).toBe("the State Benefits Renewal Office test portal");
    expect(recipientName("sandbox:county-portal")).toBe(UNNAMED_RECIPIENT);
    expect(recipientName("__proto__")).toBe(UNNAMED_RECIPIENT);
  });
});
