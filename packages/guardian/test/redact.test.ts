import { describe, expect, it } from "vitest";
import { redact, redactCheckInput } from "../src/redact.js";
import type { CheckInput } from "../src/types.js";

// All people, numbers and addresses below are invented for tests.
describe("redact", () => {
  it("redacts emails, phones, IDs, case numbers, birth dates and addresses", () => {
    const text = [
      "Contact Maria Lopez at maria.lopez@example.com or (415) 555-0132.",
      "SSN 123-45-6789, DL number D9876543.",
      "Case number SN-2026-0417, receipt IOE0912345678.",
      "DOB: 03/14/1988.",
      "Mail to 4821 Clement Street Apt 4, San Francisco, CA 94121.",
    ].join(" ");
    const out = redact(text, {
      names: ["Maria Lopez"],
      employers: ["Sunset Bakery"],
    });
    expect(out).not.toMatch(/maria\.lopez@example\.com/);
    expect(out).not.toMatch(/415/);
    expect(out).not.toMatch(/123-45-6789/);
    expect(out).not.toMatch(/D9876543/);
    expect(out).not.toMatch(/SN-2026-0417/);
    expect(out).not.toMatch(/IOE0912345678/);
    expect(out).not.toMatch(/03\/14\/1988/);
    expect(out).not.toMatch(/4821 Clement Street/);
    expect(out).not.toMatch(/94121/);
    expect(out).not.toMatch(/Maria Lopez/);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[ID]");
    expect(out).toContain("[CASE NUMBER]");
    expect(out).toContain("[DATE OF BIRTH]");
    expect(out).toContain("[ADDRESS]");
    expect(out).toContain("[NAME]");
  });

  it("redacts known employers and prefers the longest match", () => {
    const out = redact("She works at Sunset Bakery on weekends.", {
      names: [],
      employers: ["Bakery", "Sunset Bakery"],
    });
    expect(out).toBe("She works at [EMPLOYER] on weekends.");
  });

  it("redacts names case-insensitively", () => {
    const out = redact("MARIA LOPEZ signed the form.", {
      names: ["Maria Lopez"],
    });
    expect(out).toBe("[NAME] signed the form.");
  });

  it("leaves ordinary text alone", () => {
    const text = "The renewal is due in 30 days. Bring a pay stub.";
    expect(redact(text)).toBe(text);
  });

  it("handles empty input and empty entity lists", () => {
    expect(redact("")).toBe("");
    expect(redact("Nothing to hide.", { names: [""], employers: [] })).toBe(
      "Nothing to hide.",
    );
  });

  it("redacts ISO birth dates", () => {
    expect(redact("DOB: 1988-03-14")).toBe("[DATE OF BIRTH]");
    expect(redact("born 1988-03-14 in the county")).toBe(
      "[DATE OF BIRTH] in the county",
    );
    expect(redact("DOB: 03/14/1988")).toBe("[DATE OF BIRTH]");
  });

  it("redacts lowercase street addresses", () => {
    const out = redact("mail to 4821 clement street, san francisco 94121");
    expect(out).not.toMatch(/4821 clement street/);
    expect(out).toContain("[ADDRESS]");
  });

  it("redacts JSON birth-date fields", () => {
    const out = redact('{"name":"x","dob":"03/14/1988"}');
    expect(out).toBe('{"name":"x","dob":"[DATE OF BIRTH]"}');
    const out2 = redact('{"date_of_birth": "1988-03-14"}');
    expect(out2).toBe('{"date_of_birth": "[DATE OF BIRTH]"}');
  });
});

describe("redactCheckInput", () => {
  function checkInput(): CheckInput {
    return {
      action: {
        type: "send",
        recipient: "Caseworker Ana Ruiz",
        purpose: "Income check",
        payload: {
          to: "Caseworker Ana Ruiz",
          body: "Call Maria Lopez at (415) 555-0132 or maria.lopez@example.com about case SN-2026-0417, and confirm to files-backup@example.net.",
        },
        documentHash: null,
      },
      sources: [
        {
          kind: "message",
          id: "m1",
          quote: "Maria Lopez lives at 4821 Clement Street.",
        },
      ],
      consents: [
        { recipient: "Caseworker Ana Ruiz", purpose: "Income check" },
        { recipient: "Harbor Legal Aid", purpose: "Appeal help" },
      ],
      origin: "person",
    };
  }

  it("removes personal details but keeps destinations comparable", () => {
    const redacted = redactCheckInput(checkInput(), {
      names: ["Maria Lopez", "Ana Ruiz"],
    });
    const wire = JSON.stringify(redacted);
    for (const secret of [
      "Maria Lopez",
      "(415) 555-0132",
      "maria.lopez@example.com",
      "files-backup@example.net",
      "SN-2026-0417",
      "4821 Clement Street",
      "Caseworker Ana Ruiz",
      "Harbor Legal Aid",
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(redacted.action.recipient).toBe("[RECIPIENT]");
    expect(redacted.consents[0]?.recipient).toBe("[RECIPIENT]");
    expect(redacted.consents[1]?.recipient).toBe("[OTHER-1]");
    const payload = redacted.action.payload as { to: string; body: string };
    expect(payload.to).toBe("[RECIPIENT]");
    const body = payload.body;
    expect(body).toContain("[PHONE-1]");
    expect(body).toContain("[EMAIL-1]");
    expect(body).toContain("[EMAIL-2]");
    expect(body).toContain("[CASE NUMBER]");
    expect(redacted.action.purpose).toBe("Income check");
    expect(redacted.action.type).toBe("send");
    expect(redacted.origin).toBe("person");
  });

  it("labels the same destination the same way everywhere", () => {
    const redacted = redactCheckInput(checkInput());
    const quote = redacted.sources[0]?.quote ?? "";
    const payload = redacted.action.payload as { to: string };
    // The same email twice gets the same label.
    const twice: CheckInput = {
      ...checkInput(),
      action: {
        ...checkInput().action,
        payload: { text: "a@example.com then a@example.com" },
      },
    };
    const scrubbed = redactCheckInput(twice);
    expect((scrubbed.action.payload as { text: string }).text).toBe(
      "[EMAIL-1] then [EMAIL-1]",
    );
    expect(quote).not.toContain("4821 Clement Street");
    expect(payload.to).toBe("[RECIPIENT]");
  });

  it("does not mutate the input", () => {
    const input = checkInput();
    redactCheckInput(input);
    expect(input.action.recipient).toBe("Caseworker Ana Ruiz");
  });
});
