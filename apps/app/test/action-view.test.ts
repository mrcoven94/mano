import { describe, expect, it } from "vitest";
import { parseActionView, type KnownAction } from "../lib/action-view";
import { en, es } from "../lib/strings";

function request(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "submit",
    recipient: "sandbox:county-portal",
    purpose: "File renewal",
    payload: { caseId: "R-1042" },
    idempotencyKey: "k-1",
    actor: "foreground",
    personId: "maria-001",
    ...overrides,
  });
}

function known(json: string): KnownAction {
  const parsed = parseActionView(json);
  if (parsed.kind === "unknown") throw new Error(`unexpected unknown: ${parsed.reason}`);
  return parsed;
}

function field(action: KnownAction, key: string) {
  return action.answers.find((f) => f.key === key);
}

describe("parseActionView", () => {
  it("keeps every field the executor will use", () => {
    const parsed = known(request({ documentId: "doc-1", payload: { caseId: "R-1042", office: "Springfield", copies: 2 } }));
    expect(parsed.kind).toBe("submit");
    expect(parsed.recipient).toBe("sandbox:county-portal");
    expect(parsed.purpose).toBe("File renewal");
    expect(parsed.reference).toBe("k-1");
    expect(parsed.documentId).toBe("doc-1");
    expect(parsed.answers.map((f) => f.key)).toEqual(["caseId", "office", "copies"]);
    expect(field(parsed, "caseId")).toMatchObject({ label: "fieldCase", value: "R-1042" });
    expect(field(parsed, "office")).toMatchObject({ label: "fieldOffice", value: "Springfield" });
    // An unknown name keeps its raw key so nothing is hidden.
    expect(field(parsed, "copies")).toMatchObject({ label: null, value: "2" });
  });

  it("labels the renewal form's answers and lifts out the statement and attachment", () => {
    const parsed = known(
      request({
        documentId: "doc-1",
        payload: {
          caseNumber: "R-1042",
          fullName: "Maria Torres",
          dateOfBirth: "1990-04-12",
          householdSize: "2",
          monthlyIncome: "1940",
          address: "418 Alder St Apt 3, Springfield",
          phone: "555-0100",
          declaration: "I declare this is true.",
          attachment: "Proof of income",
        },
      }),
    );
    expect(parsed.answers.map((f) => f.label)).toEqual([
      "fieldCase",
      "fieldName",
      "fieldBirth",
      "fieldHousehold",
      "fieldIncome",
      "fieldAddress",
      "fieldPhone",
    ]);
    expect(field(parsed, "monthlyIncome")?.format).toBe("money");
    expect(parsed.declaration).toBe("I declare this is true.");
    expect(parsed.attachment).toBe("Proof of income");
    expect(field(parsed, "declaration")).toBeUndefined();
  });

  it("gives every label it can return in both languages", () => {
    const parsed = known(
      request({
        payload: { caseNumber: "1", fullName: "a", dateOfBirth: "b", householdSize: "2", monthlyIncome: "3", address: "c", phone: "d", office: "e", text: "f", to: "g", scope: ["h"] },
      }),
    );
    for (const f of parsed.answers) {
      expect(f.label).not.toBeNull();
      if (f.label) {
        expect(en[f.label].length).toBeGreaterThan(0);
        expect(es[f.label].length).toBeGreaterThan(0);
      }
    }
  });

  it("formats only a plain amount as money", () => {
    expect(field(known(request({ payload: { monthlyIncome: "1940.50" } })), "monthlyIncome")?.format).toBe("money");
    expect(field(known(request({ payload: { monthlyIncome: "about 1900" } })), "monthlyIncome")).toMatchObject({
      format: "text",
      value: "about 1900",
    });
    // Leading zeros or more digits than an amount has stay exactly as filed.
    expect(field(known(request({ payload: { monthlyIncome: "0019" } })), "monthlyIncome")?.format).toBe("text");
    expect(field(known(request({ payload: { monthlyIncome: "12345678901234567890" } })), "monthlyIncome")?.format).toBe("text");
  });

  it("formats only a real calendar day as a date", () => {
    expect(field(known(request({ payload: { dateOfBirth: "1988-03-14" } })), "dateOfBirth")?.format).toBe("date");
    expect(field(known(request({ payload: { dateOfBirth: "1988-02-30" } })), "dateOfBirth")).toMatchObject({ format: "text", value: "1988-02-30" });
    expect(field(known(request({ payload: { dateOfBirth: "March 14" } })), "dateOfBirth")?.format).toBe("text");
  });

  it("keeps a statement or attachment that is not plain text as a row", () => {
    const parsed = known(request({ payload: { declaration: { signed: true }, attachment: "" } }));
    expect(parsed.declaration).toBeNull();
    expect(parsed.attachment).toBeNull();
    expect(field(parsed, "declaration")?.value).toContain("signed");
    expect(field(parsed, "attachment")?.value).toBe("");
  });

  it("shows the full message text of a send", () => {
    const parsed = known(request({ type: "send", payload: { text: "Hello, this is your renewal reminder." } }));
    expect(field(parsed, "text")).toMatchObject({ label: "fieldMessage", value: "Hello, this is your renewal reminder." });
  });

  it("shows grant scope and revoke plainly", () => {
    const grant = known(request({ type: "share", payload: { consent: "grant", caseId: "R-1", scope: ["deadlines", "documents"] } }));
    expect(field(grant, "consent")).toMatchObject({ format: "consent", value: "grant" });
    expect(field(grant, "scope")?.value).toBe("deadlines, documents");
    const revoke = known(request({ type: "share", payload: { consent: "revoke", caseId: "R-1" } }));
    expect(field(revoke, "consent")?.value).toBe("revoke");
  });

  it("shows long values in full instead of truncating", () => {
    const long = "x".repeat(5000);
    expect(field(known(request({ type: "send", payload: { text: long } })), "text")?.value).toBe(long);
  });

  it("renders objects and arrays without losing entries", () => {
    const parsed = known(request({ payload: { nested: { a: 1 }, list: [1, 2] } }));
    expect(field(parsed, "nested")?.value).toContain('"a":1');
    expect(field(parsed, "list")?.value).toContain("1");
  });

  it("rejects what it cannot read", () => {
    expect(parseActionView("not json").kind).toBe("unknown");
    expect(parseActionView("[1,2]").kind).toBe("unknown");
    expect(parseActionView(request({ type: "teleport" })).kind).toBe("unknown");
    expect(parseActionView(request({ recipient: "" })).kind).toBe("unknown");
    expect(parseActionView(request({ payload: "text" })).kind).toBe("unknown");
    expect(parseActionView(request({ payload: null })).kind).toBe("unknown");
    expect(parseActionView(request({ type: "share", payload: { consent: "maybe", caseId: "R-1" } })).kind).toBe(
      "unknown",
    );
    expect(parseActionView(request({ type: "share", payload: { consent: "grant" } })).kind).toBe("unknown");
  });

  it("treats prototype names as inert data", () => {
    const payload = JSON.parse('{"__proto__":"x","toString":"y"}') as Record<string, unknown>;
    const parsed = known(request({ payload }));
    expect(field(parsed, "__proto__")).toMatchObject({ label: null, value: "x" });
    expect(field(parsed, "toString")).toMatchObject({ label: null, value: "y" });
  });
});
