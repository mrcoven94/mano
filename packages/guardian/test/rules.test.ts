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

  it("accepts a quote contained in a longer claim", async () => {
    const input = goodInput();
    input.sources = [
      { kind: "message", id: "m1", quote: "SNAP case for 2026" },
    ];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
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

  it("passes when the payload carries no claims", async () => {
    const input = goodInput();
    input.action.payload = { formId: "snap-renewal", fields: 12 };
    input.sources = [];
    const result = await new RulesChecker().check(input);
    expect(result.verdict).toBe("pass");
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
