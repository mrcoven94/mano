import { describe, expect, it } from "vitest";
import { redact, buildModelRequest } from "../src/redact.js";
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

  it("redacts bare dates", () => {
    expect(redact("filed on 2026-10-28")).toBe("filed on [DATE]");
    expect(redact("filed on 10/28/2026")).toBe("filed on [DATE]");
  });

  it("redacts JSON birth-date fields", () => {
    const out = redact('{"name":"x","dob":"03/14/1988"}');
    expect(out).toBe('{"name":"x","dob":"[DATE OF BIRTH]"}');
    const out2 = redact('{"date_of_birth": "1988-03-14"}');
    expect(out2).toBe('{"date_of_birth": "[DATE OF BIRTH]"}');
  });
});

describe("buildModelRequest", () => {
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
    const redacted = buildModelRequest(checkInput(), {
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
    const redacted = buildModelRequest(checkInput());
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
    const scrubbed = buildModelRequest(twice);
    expect((scrubbed.action.payload as { text: string }).text).toBe(
      "[EMAIL-1] then [EMAIL-1]",
    );
    expect(quote).not.toContain("4821 Clement Street");
    expect(payload.to).toBe("[RECIPIENT]");
  });

  it("does not mutate the input", () => {
    const input = checkInput();
    buildModelRequest(input);
    expect(input.action.recipient).toBe("Caseworker Ana Ruiz");
  });

  it("keeps case-distinct destinations distinct", () => {
    const input = checkInput();
    input.action.payload = {
      text: "Write to Benefits@example.com, not benefits@example.com.",
    };
    const redacted = buildModelRequest(input);
    const text = (redacted.action.payload as { text: string }).text;
    expect(text).toBe("Write to [EMAIL-1], not [EMAIL-2].");
  });

  it("redacts source ids and drops unknown fields", () => {
    const input = checkInput();
    input.sources = [
      {
        kind: "message",
        id: "1975-06-30",
        quote: "See the attached file.",
        note: "SSN 123-45-6789",
      } as CheckInput["sources"][number],
    ];
    input.action.payload = {
      text: "See the attached file.",
      cc: "attacker@example.com",
    };
    const withExtras = input as unknown as Record<string, unknown>;
    withExtras["note"] = "Call (415) 555-0100.";
    (input.action as unknown as Record<string, unknown>)["cc"] =
      "attacker@example.com";
    const redacted = buildModelRequest(input);
    const wire = JSON.stringify(redacted);
    for (const secret of [
      "1975-06-30",
      "SSN 123-45-6789",
      "attacker@example.com",
      "(415) 555-0100",
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(redacted.sources[0]?.id).toBe("[DATE]");
    expect(redacted.action.payload).toEqual({ text: "See the attached file." });
    expect(wire).not.toContain("documentHash");
  });

  it("labels case-distinct paths distinctly", () => {
    const input = checkInput();
    input.action.type = "send";
    input.action.recipient = "https://example.com/Claim";
    input.action.payload = {
      to: "https://example.com/Claim",
      body: "See https://example.com/Claim and https://example.com/claim.",
    };
    input.consents = [
      { recipient: "https://example.com/Claim", purpose: "Income check" },
    ];
    const redacted = buildModelRequest(input);
    const payload = redacted.action.payload as { to: string; body: string };
    expect(payload.to).toBe("[RECIPIENT]");
    expect(payload.body).toBe("See [RECIPIENT] and [URL-1]");
  });
});

describe("buildModelRequest for a renewal form", () => {
  const MARIA = {
    fullName: "Maria Synthetic",
    dateOfBirth: "1990-01-01",
    address: "12 Example Lane, Springfield, IL 62701",
    phone: "(312) 555-0142",
  };
  const RAW = [
    "Maria Synthetic",
    "1990-01-01",
    "12 Example Lane",
    "Springfield",
    "62701",
    "(312) 555-0142",
    "555-0142",
  ];

  function renewal(payload: Record<string, unknown>, documentHash: string | null = "doc-hash"): CheckInput {
    return {
      action: {
        type: "submit",
        recipient: "sandbox-agency-portal",
        purpose: "Food benefits renewal in the sandbox agency portal",
        payload,
        documentHash,
      },
      sources: [],
      consents: [],
      origin: "person",
    };
  }

  it("sends every form field, personal values as labels and numbers as numbers", () => {
    const sent = buildModelRequest(renewal({ ...MARIA, householdSize: 3, monthlyIncome: 1200 }));
    expect(sent.action.payload).toEqual({
      fullName: "[NAME]",
      dateOfBirth: "[DATE OF BIRTH]",
      address: "[ADDRESS]",
      phone: "[PHONE]",
      householdSize: 3,
      monthlyIncome: 1200,
      attachment: "[DOCUMENT]",
    });
    const wire = JSON.stringify(sent);
    for (const raw of RAW) expect(wire).not.toContain(raw);
    expect(wire).not.toContain("doc-hash");
  });

  it("reads the portal's saved strings as numbers and keeps impossible values visible", () => {
    const filled = buildModelRequest(renewal({ ...MARIA, householdSize: "3", monthlyIncome: "1200.50" }));
    expect(filled.action.payload).toMatchObject({ householdSize: 3, monthlyIncome: 1200.5 });
    const wrong = buildModelRequest(renewal({ ...MARIA, householdSize: 0, monthlyIncome: -200 }));
    expect(wrong.action.payload).toMatchObject({ householdSize: 0, monthlyIncome: -200 });
  });

  it("shows an empty personal field as empty and leaves out a missing one", () => {
    const sent = buildModelRequest(renewal({ fullName: "  ", householdSize: 2 }, null));
    expect(sent.action.payload).toEqual({ fullName: "", householdSize: 2 });
  });

  it("scrubs text in a number field, so a phone typed there is still caught", () => {
    const sent = buildModelRequest(
      renewal({
        ...MARIA,
        householdSize: "three",
        monthlyIncome: "(312) 555-0142, call Maria Synthetic",
      }),
    );
    expect(sent.action.payload).toMatchObject({ householdSize: "three" });
    const income = (sent.action.payload as { monthlyIncome: string }).monthlyIncome;
    expect(income).not.toContain("555-0142");
    expect(income).not.toContain("Maria Synthetic");
  });

  it("removes the form's personal values from the purpose, text, claims and quotes", () => {
    const input = renewal({
      ...MARIA,
      householdSize: 3,
      monthlyIncome: 1200,
      text: "Maria Synthetic lives at 12 Example Lane, Springfield, IL 62701.",
      claims: ["Maria Synthetic was born 1990-01-01."],
    });
    input.action.purpose = "Food benefits renewal for Maria Synthetic";
    input.sources = [{ kind: "profile", id: "p1", quote: "maria synthetic, Springfield" }];
    const wire = JSON.stringify(buildModelRequest(input));
    for (const raw of RAW) expect(wire.toLowerCase()).not.toContain(raw.toLowerCase());
    expect(wire).toContain("Food benefits renewal for [NAME]");
  });

  it("sends form fields only on a submit, and the attachment only on a submit", () => {
    const send: CheckInput = {
      ...renewal({ ...MARIA, text: "Hello." }),
      action: { ...renewal({}).action, type: "send", payload: { ...MARIA, text: "Hello." } },
    };
    const sent = buildModelRequest(send);
    expect(sent.action.payload).toEqual({ text: "Hello." });
  });
});

describe("known entities", () => {
  it("removes each kind by value, longest first across kinds", () => {
    const out = redact(
      "Maria's Bakery pays Maria. Write to Unit 4, Springfield. Case A77Q. mail m.s@post.example.",
      {
        names: ["Maria"],
        employers: ["Maria's Bakery"],
        addresses: ["Unit 4", "Springfield"],
        caseNumbers: ["A77Q"],
        emails: ["m.s@post.example"],
      },
    );
    expect(out).toBe("[EMPLOYER] pays [NAME]. Write to [ADDRESS], [ADDRESS]. Case [CASE NUMBER]. mail [EMAIL].");
  });

  it("removes a known address whole before a pattern can split it", () => {
    const out = redact("Send it to 12 Example Lane, Springfield, IL 62701 today.", {
      addresses: ["12 Example Lane, Springfield, IL 62701"],
    });
    expect(out).toBe("Send it to [ADDRESS] today.");
  });
});
