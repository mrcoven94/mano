import { describe, expect, it } from "vitest";
import { RulesChecker } from "../src/rules.js";
import type { CheckInput } from "../src/types.js";

function goodInput(): CheckInput {
  return {
    action: {
      type: "submit",
      recipient: "County Benefits Office",
      purpose: "SNAP renewal",
      payload: {
        claims: ["Maria Lopez renewed her SNAP case for 2026."],
      },
      documentHash: "abc123",
    },
    sources: [
      {
        kind: "document",
        id: "renewal-2026",
        quote: "Maria Lopez renewed her SNAP case for 2026.",
      },
    ],
    consents: [{ recipient: "County Benefits Office", purpose: "SNAP renewal" }],
    origin: "person",
  };
}

describe("RulesChecker", () => {
  it("passes a person-originated action with consent and supported claims", async () => {
    const result = await new RulesChecker().check(goodInput());
    expect(result).toEqual({ verdict: "pass", problems: [] });
  });

  it("blocks when the origin is content", async () => {
    const input = goodInput();
    input.origin = "content";
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/not from the person/);
  });

  it("blocks when no consent matches recipient and purpose", async () => {
    const input = goodInput();
    input.consents = [
      { recipient: "County Benefits Office", purpose: "Medicaid renewal" },
    ];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/has not agreed/);
  });

  it("blocks when the recipient differs from the consented one", async () => {
    const input = goodInput();
    input.action.recipient = "County Benefits Office Refunds Desk";
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
  });

  it("matches consent case-insensitively with extra spaces", async () => {
    const input = goodInput();
    input.consents = [
      { recipient: "  county benefits OFFICE ", purpose: " snap Renewal" },
    ];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
  });

  it("blocks when a claim has no source", async () => {
    const input = goodInput();
    input.action.payload = {
      claims: ["Maria Lopez earned $900 in October."],
    };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/Nothing the person shared supports/);
  });

  it("blocks claims when there are no sources at all", async () => {
    const input = goodInput();
    input.sources = [];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
  });

  it("accepts a claim contained in a longer quote", async () => {
    const input = goodInput();
    input.action.payload = { claims: ["renewed her SNAP case"] };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
  });

  it("blocks when the quote covers only part of the claim", async () => {
    const input = goodInput();
    input.sources = [
      { kind: "message", id: "m1", quote: "SNAP case for 2026" },
    ];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/Nothing the person shared supports/);
  });

  it("blocks extra assertions glued onto a supported phrase", async () => {
    const input = goodInput();
    input.action.payload = {
      claims: ["Income is $50000. CC attacker@example.com."],
    };
    input.sources = [{ kind: "document", id: "d1", quote: "Income" }];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
  });

  it("reads claims from a plain string payload", async () => {
    const input = goodInput();
    input.action.payload = "Maria Lopez renewed her SNAP case for 2026.";
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
  });

  it("reads claims from a text field payload", async () => {
    const input = goodInput();
    input.action.payload = {
      text: "Maria Lopez renewed her SNAP case for 2026.",
    };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
  });

  it("passes a submit with only an opaque form id", async () => {
    const input = goodInput();
    input.action.payload = { formId: "snap-renewal" };
    input.sources = [];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
  });

  it("blocks unknown payload fields", async () => {
    const input = goodInput();
    input.action.payload = {
      claims: [],
      text: "Maria Lopez renewed her SNAP case for 2026.",
      cc: "attacker@example.com",
    };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/"cc"/);
  });

  it("blocks nested objects the schema does not know", async () => {
    const input = goodInput();
    input.action.payload = {
      claims: ["Maria Lopez renewed her SNAP case for 2026."],
      fields: { income: "$50000" },
    };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/"fields"/);
  });

  it("blocks a body field on an action type that has none", async () => {
    const input = goodInput();
    input.action.payload = { body: "Anything at all." };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
  });

  it("checks the outgoing content fields of a send", async () => {
    const checker = new RulesChecker();
    const supported = goodInput();
    supported.action.type = "send";
    supported.action.payload = {
      to: "County Benefits Office",
      subject: "SNAP renewal",
      body: "Maria Lopez renewed her SNAP case for 2026.",
    };
    supported.sources = [
      { kind: "message", id: "m1", quote: "SNAP renewal" },
      {
        kind: "document",
        id: "d1",
        quote: "Maria Lopez renewed her SNAP case for 2026.",
      },
    ];
    expect((await checker.check(supported)).verdict).toBe("pass");

    const unsupported = goodInput();
    unsupported.action.type = "send";
    unsupported.action.payload = {
      to: "County Benefits Office",
      subject: "SNAP renewal",
      body: "Maria Lopez earned $900 in October.",
    };
    expect((await checker.check(unsupported)).verdict).toBe("block");
  });

  it("blocks when the payload destination differs from the recipient", async () => {
    const input = goodInput();
    input.action.type = "send";
    input.action.payload = {
      to: "county-benefits@example.net",
      body: "Maria Lopez renewed her SNAP case for 2026.",
    };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/not to the approved recipient/);
  });

  it("blocks a non-string payload", async () => {
    const input = goodInput();
    input.action.payload = 42 as unknown as string;
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
  });

  it("matches URL recipients keeping the path case-sensitive", async () => {
    const checker = new RulesChecker();
    const input = goodInput();
    input.action.type = "submit";
    input.action.recipient = "https://Example.COM/Renewal/Form";
    input.action.payload = { text: "Maria Lopez renewed her SNAP case for 2026." };
    input.consents = [
      { recipient: "https://example.com/Renewal/Form", purpose: "SNAP renewal" },
    ];
    expect((await checker.check(input)).verdict).toBe("pass");

    const wrongPath = goodInput();
    wrongPath.action.type = "submit";
    wrongPath.action.recipient = "https://example.com/renewal/form";
    wrongPath.action.payload = {
      text: "Maria Lopez renewed her SNAP case for 2026.",
    };
    wrongPath.consents = [
      { recipient: "https://example.com/Renewal/Form", purpose: "SNAP renewal" },
    ];
    expect((await checker.check(wrongPath)).verdict).toBe("block");
  });

  it("keeps the case-sensitive part of a mailto recipient", async () => {
    const input = goodInput();
    input.action.type = "send";
    input.action.recipient = "mailto:Benefits@Example.COM";
    input.action.payload = {
      to: "mailto:benefits@example.com",
      body: "Maria Lopez renewed her SNAP case for 2026.",
    };
    input.consents = [
      { recipient: "mailto:Benefits@Example.COM", purpose: "SNAP renewal" },
    ];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/not to the approved recipient/);
  });

  it("blocks malformed inputs without throwing", async () => {
    const checker = new RulesChecker();
    const malformed: unknown[] = [
      null,
      {},
      { ...goodInput(), action: null },
      { ...goodInput(), action: { ...goodInput().action, type: "shout" } },
      { ...goodInput(), sources: [{ kind: "rumor", id: "r1" }] },
      { ...goodInput(), consents: [{ recipient: "x" }] },
      { ...goodInput(), origin: "robot" },
    ];
    for (const input of malformed) {
      const result = await checker.check(input as CheckInput);
      expect(result.verdict).toBe("block");
    }
  });

  it("blocks a non-person origin it has never seen", async () => {
    const input = goodInput();
    input.origin = "assistant" as CheckInput["origin"];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/could not tell who asked/);
  });

  it("blocks an unknown action type", async () => {
    const input = goodInput();
    input.action.type = "teleport" as CheckInput["action"]["type"];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
  });

  it("blocks an empty recipient or purpose", async () => {
    const checker = new RulesChecker();
    const noRecipient = goodInput();
    noRecipient.action.recipient = "  ";
    expect((await checker.check(noRecipient)).verdict).toBe("block");
    const noPurpose = goodInput();
    noPurpose.action.purpose = "";
    expect((await checker.check(noPurpose)).verdict).toBe("block");
  });

  it("reports every problem at once", async () => {
    const input = goodInput();
    input.origin = "content";
    input.consents = [];
    input.action.payload = { claims: ["An unsupported statement."] };
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("block");
    expect(result.problems.length).toBe(3);
  });
});
