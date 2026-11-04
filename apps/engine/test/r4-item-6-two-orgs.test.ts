import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 4, item 6 through real agents: consent keys identify the
// organization, so one case shared with two orgs revokes from each
// independently.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r4 item 6: one case, two orgs, independent revokes", () => {
  it("shares with two orgs and revokes from each", async () => {
    const person = personStub("r4i6-maria");
    const orgA = orgStub("r4i6-county-a");
    const orgB = orgStub("r4i6-county-b");
    const orgAId = "org:r4i6-county-a";
    const orgBId = "org:r4i6-county-b";

    const grantA = await person.grantConsent("r4i6-maria", {
      orgAgentId: orgAId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i6",
    });
    expect(grantA.status).toBe("needs_approval");
    expect(grantA.approval!.idempotencyKey).toContain(orgAId);
    expect(await person.approve(grantA.approval!.id, "r4i6-maria")).toMatchObject({ status: "completed" });

    const grantB = await person.grantConsent("r4i6-maria", {
      orgAgentId: orgBId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i6",
    });
    expect(grantB.status, grantB.reason).toBe("needs_approval");
    expect(grantB.approval!.idempotencyKey).toContain(orgBId);
    expect(grantB.approval!.idempotencyKey).not.toBe(grantA.approval!.idempotencyKey);
    expect(await person.approve(grantB.approval!.id, "r4i6-maria")).toMatchObject({ status: "completed" });

    expect((await orgA.listCases("r4i6-county-a")).map((c) => c.caseId)).toContain("case-r4i6");
    expect((await orgB.listCases("r4i6-county-b")).map((c) => c.caseId)).toContain("case-r4i6");

    const revokeA = await person.revokeConsent("r4i6-maria", { orgAgentId: orgAId, caseId: "case-r4i6" });
    expect(revokeA.status).toBe("needs_approval");
    expect(await person.approve(revokeA.approval!.id, "r4i6-maria")).toMatchObject({ status: "completed" });

    const revokeB = await person.revokeConsent("r4i6-maria", { orgAgentId: orgBId, caseId: "case-r4i6" });
    expect(revokeB.status, revokeB.reason).toBe("needs_approval");
    expect(await person.approve(revokeB.approval!.id, "r4i6-maria")).toMatchObject({ status: "completed" });

    expect((await orgA.listCases("r4i6-county-a")).map((c) => c.caseId)).not.toContain("case-r4i6");
    expect((await orgB.listCases("r4i6-county-b")).map((c) => c.caseId)).not.toContain("case-r4i6");
  });
});
