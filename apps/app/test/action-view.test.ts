import { describe, expect, it } from "vitest";
import { parseActionView } from "../lib/action-view";

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

describe("parseActionView", () => {
  it("renders every field the executor will use", async () => {
    const parsed = parseActionView(
      request({ documentId: "doc-1", payload: { caseId: "R-1042", office: "Springfield", copies: 2 } }),
    );
    if (parsed.kind === "unknown") throw new Error(`unexpected unknown: ${parsed.reason}`);
    expect(parsed.kind).toBe("submit");
    const labels = parsed.rows.map((r) => r.label);
    expect(labels).toContain("To");
    expect(labels).toContain("Why");
    expect(labels).toContain("Reference");
    expect(labels).toContain("Document");
    expect(labels).toContain("Case");
    const values = Object.fromEntries(parsed.rows.map((r) => [r.label, r.value]));
    expect(values["To"]).toBe("sandbox:county-portal");
    expect(values["Case"]).toBe("R-1042");
    expect(values["copies"]).toBe("2");
  });

  it("shows the full message text of a send", async () => {
    const parsed = parseActionView(request({ type: "send", payload: { text: "Hello, this is your renewal reminder." } }));
    if (parsed.kind === "unknown") throw new Error(`unexpected unknown: ${parsed.reason}`);
    const message = parsed.rows.find((r) => r.label === "Message");
    expect(message?.value).toBe("Hello, this is your renewal reminder.");
  });

  it("shows grant scope and revoke plainly", async () => {
    const grant = parseActionView(
      request({ type: "share", payload: { consent: "grant", caseId: "R-1", scope: ["deadlines", "documents"] } }),
    );
    if (grant.kind === "unknown") throw new Error(`unexpected unknown: ${grant.reason}`);
    const values = Object.fromEntries(grant.rows.map((r) => [r.label, r.value]));
    expect(values["Consent"]).toBe("grant");
    expect(values["Scope"]).toBe("deadlines, documents");
    const revoke = parseActionView(request({ type: "share", payload: { consent: "revoke", caseId: "R-1" } }));
    if (revoke.kind === "unknown") throw new Error(`unexpected unknown: ${revoke.reason}`);
    expect(revoke.rows.find((r) => r.label === "Consent")?.value).toBe("revoke");
  });

  it("renders objects and arrays without losing entries", async () => {
    const parsed = parseActionView(request({ payload: { nested: { a: 1 }, list: [1, 2] } }));
    if (parsed.kind === "unknown") throw new Error(`unexpected unknown: ${parsed.reason}`);
    expect(parsed.rows.find((r) => r.label === "nested")?.value).toContain('"a":1');
    expect(parsed.rows.find((r) => r.label === "list")?.value).toContain("1");
  });

  it("rejects what it cannot read", async () => {
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

  it("treats prototype names as inert data", async () => {
    const payload = JSON.parse('{"__proto__":"x","toString":"y"}') as Record<string, unknown>;
    const parsed = parseActionView(request({ payload }));
    if (parsed.kind === "unknown") throw new Error(`unexpected unknown: ${parsed.reason}`);
    expect(parsed.rows.find((r) => r.label === "__proto__")?.value).toBe("x");
  });
});
