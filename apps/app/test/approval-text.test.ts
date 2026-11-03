import { describe, expect, it } from "vitest";
import { parseActionView, type KnownAction } from "../lib/action-view";
import { fieldValue, leadLine } from "../lib/approval-text";
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
    const [grant] = known("share", { consent: "grant", caseId: "R-1" }).answers;
    expect(fieldValue(grant!, es, "es")).toBe(es.consentGrant);
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
