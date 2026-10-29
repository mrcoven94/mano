import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 4, item 4 through real agents: the steady-state revoke contract
// the atomic rewrite must preserve. A revoke delivers, the org's
// reconcile record reflects the revoke event, a retry of the same key is
// accepted as a duplicate, and the case stays gone.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r4 item 4: revoke delivery and reconcile", () => {
  it("delivers a revoke, reconciles from its record, and absorbs a retry", async () => {
    const person = personStub("r4i4-revoke");
    const org = orgStub("r4i4-revoke-county");
    const orgAgentId = "org:r4i4-revoke-county";
    const grant = await person.grantConsent("r4i4-revoke", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i4-revoke",
    });
    const granted = await person.approve(grant.approval!.id, "r4i4-revoke");
    expect(granted.status, granted.reason).toBe("completed");
    expect((await org.listCases("r4i4-revoke-county")).map((c) => c.caseId)).toContain("case-r4i4-revoke");

    const revoke = await person.revokeConsent("r4i4-revoke", { orgAgentId, caseId: "case-r4i4-revoke" });
    const revoked = await person.approve(revoke.approval!.id, "r4i4-revoke");
    expect(revoked.status, revoked.reason).toBe("completed");
    const revokeKey = revoke.approval!.idempotencyKey;

    // The org recorded the revoke: reconcile sees the event record.
    expect(await org.hasConsentRecord("person:r4i4-revoke", revokeKey, "revoke")).toBe(true);
    // The grant consult under the same key stays empty: a revoke record
    // never satisfies a grant reconcile.
    expect(await org.hasConsentRecord("person:r4i4-revoke", revokeKey, "share")).toBe(false);
    expect((await org.listCases("r4i4-revoke-county")).map((c) => c.caseId)).not.toContain("case-r4i4-revoke");

    // Same key retried: the gateway replays the receipt without
    // redelivering, case still gone.
    const again = await person.revokeConsent("r4i4-revoke", { orgAgentId, caseId: "case-r4i4-revoke" });
    expect(again.status).toBe("completed");
    expect(again.receipt!.idempotencyKey).toBe(revokeKey);
    expect((await org.listCases("r4i4-revoke-county")).map((c) => c.caseId)).not.toContain("case-r4i4-revoke");
    expect(await org.hasConsentRecord("person:r4i4-revoke", revokeKey, "revoke")).toBe(true);
  });
});
