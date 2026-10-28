import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

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
});
