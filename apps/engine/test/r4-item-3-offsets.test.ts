import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 4, item 3 through real agents: consent expiry is parsed and
// stored as epoch milliseconds and compared numerically, so non-UTC
// offsets behave. Lexical comparison both drops live negative-offset
// grants and keeps passed positive-offset ones.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

// Formats an instant with a numeric offset, e.g. offsetIso(t, -5) ends
// in "-05:00". Verifies the round trip so the test cannot lie to itself.
function offsetIso(instantMs: number, offsetHours: number): string {
  // Consent expiries carry second precision; floor so the round trip is exact.
  const t = Math.floor(instantMs / 1000) * 1000;
  const sign = offsetHours < 0 ? "-" : "+";
  const abs = Math.abs(offsetHours);
  const suffix = `${sign}${String(abs).padStart(2, "0")}:00`;
  const str = `${new Date(t + offsetHours * 3600_000).toISOString().slice(0, 19)}${suffix}`;
  expect(new Date(str).getTime()).toBe(t);
  return str;
}

describe("r4 item 3: consent expiry with non-UTC offsets", () => {
  it("keeps a live grant written with a negative offset", async () => {
    const person = personStub("r4i3-neg");
    const org = orgStub("r4i3-neg-county");
    const orgAgentId = "org:r4i3-neg-county";
    const grant = await person.grantConsent("r4i3-neg", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i3-neg",
      expiresAt: offsetIso(Date.now() + 30 * 60_000, -5),
    });
    expect(grant.status).toBe("needs_approval");
    const done = await person.approve(grant.approval!.id, "r4i3-neg");
    expect(done.status, done.reason).toBe("completed");
    expect((await org.listCases("r4i3-neg-county")).map((c) => c.caseId)).toContain("case-r4i3-neg");
  });

  it("shows a negative-offset grant to the checker", async () => {
    const person = personStub("r4i3-checker");
    const orgAgentId = "org:r4i3-checker-county";
    const grant = await person.grantConsent("r4i3-checker", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i3-checker",
      expiresAt: offsetIso(Date.now() + 30 * 60_000, -5),
    });
    const done = await person.approve(grant.approval!.id, "r4i3-checker");
    expect(done.status, done.reason).toBe("completed");

    const probe = await person.grantConsent("r4i3-checker", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i3-checker-probe",
    });
    expect(probe.status).toBe("needs_approval");
    expect(probe.approval!.problems.join(" ")).not.toMatch(/no recorded consent/i);
  });

  it("drops a positive-offset grant once its instant passes", async () => {
    const person = personStub("r4i3-pos");
    const org = orgStub("r4i3-pos-county");
    const grant = await person.grantConsent("r4i3-pos", {
      orgAgentId: "org:r4i3-pos-county",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i3-pos",
      expiresAt: offsetIso(Date.now() + 1500, 14),
    });
    expect(grant.status).toBe("needs_approval");
    const done = await person.approve(grant.approval!.id, "r4i3-pos");
    expect(done.status, done.reason).toBe("completed");

    await new Promise((r) => setTimeout(r, 1500));
    expect((await org.listCases("r4i3-pos-county")).map((c) => c.caseId)).not.toContain("case-r4i3-pos");
  });

  it("refuses a grant whose positive-offset instant already passed", async () => {
    const person = personStub("r4i3-past");
    const result = await person.grantConsent("r4i3-past", {
      orgAgentId: "org:r4i3-past-county",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i3-past",
      expiresAt: offsetIso(Date.now() - 1000, 14),
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/expir/i);
  });
});
