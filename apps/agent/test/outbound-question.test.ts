import { describe, expect, it } from "vitest";

import { presentsExactly, renderQuestion, requestStatus } from "../agent/lib/pending.js";
import type { EngineApproval } from "../agent/lib/engine.js";

// What a person reads before their yes on a fax or a letter: the price,
// the pages and where it goes, word for word, or it is not put to a yes.

function question(recipient: string, payload: Record<string, unknown>) {
  return renderQuestion({ purpose: "your renewal letter", recipient, requestJson: JSON.stringify({ documentId: "doc-1", payload }) });
}

describe("the question for a fax or a letter", () => {
  it("shows a letter's price and that nothing is really mailed", () => {
    const text = question("mano-practice-mailbox", {
      "Mail to": "State Benefits Office, 100 Practice Way, Sacramento, CA 95814",
      "Return address": "Maria Testperson, 1 Example St, Sacramento, CA 95814",
      "Approved by": "Maria Testperson",
      Pages: 3,
      Price: "$1.05, not charged in practice",
    });
    expect(text).toContain("to a practice mailbox where nothing is really mailed");
    expect(text).toContain("Price: $1.05, not charged in practice");
    expect(text.indexOf("Price:")).toBeLessThan(text.indexOf("Reply YES"));
    expect(presentsExactly(text)).toBe(true);
  });

  it("shows a fax's price and our own line", () => {
    const text = question("mano-test-fax-line", {
      "Fax to": "+15550100001",
      "Approved by": "Maria Testperson",
      Pages: 2,
      Price: "$0.04, not charged on the test line",
    });
    expect(text).toContain("to the Mano test fax line");
    expect(text).toContain("Fax to: +15550100001");
    expect(text).toContain("Price: $0.04, not charged on the test line");
    expect(presentsExactly(text)).toBe(true);
  });
});

describe("what the model is told about a fax Mano stopped checking", () => {
  it("says it could not be confirmed and only a new approval sends it, not that it is still being checked", () => {
    const approval = {
      id: "a1",
      idempotencyKey: "agent:g0:turn:d0",
      status: "approved",
      purpose: "your renewal letter",
      createdAt: "2026-11-03T10:00:00.000Z",
      outcome: { attempt: "unknown", receipt: null, lookupsEnded: true },
    } as unknown as EngineApproval;
    const status = requestStatus([approval], 0, null)!;
    expect(status).toMatch(/could not confirm/i);
    expect(status).toMatch(/new approval/i);
    expect(status).not.toMatch(/is checking/i);
  });
});
