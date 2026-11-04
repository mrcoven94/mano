import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Re-review blocker 3: each case is bound to the resident who first shared
// it. Nobody else's valid signature can grant or revoke it.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r2 blocker 3: a case belongs to the resident who shared it", () => {
  it("rejects eve revoking alice's case", async () => {
    const alice = personStub("r2b3-alice");
    const eve = personStub("r2b3-eve");
    const org = orgStub("r2b3-county");
    const orgAgentId = "org:r2b3-county";

    const grant = await alice.grantConsent("r2b3-alice", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r2b3",
    });
    expect(grant.status).toBe("needs_approval");
    expect(await alice.approve(grant.approval!.id, "r2b3-alice")).toMatchObject({ status: "completed" });
    expect((await org.listCases("r2b3-county")).map((c) => c.caseId)).toContain("case-r2b3");

    // Eve's own signature is valid, but the case is not hers to revoke.
    const revoke = await eve.revokeConsent("r2b3-eve", { orgAgentId, caseId: "case-r2b3" });
    expect(revoke.status).toBe("needs_approval");
    const attempt = await eve.approve(revoke.approval!.id, "r2b3-eve");
    expect(attempt.status).toBe("blocked");
    const cases = await org.listCases("r2b3-county");
    expect(cases.map((c) => c.caseId)).toContain("case-r2b3");
    expect(cases.find((c) => c.caseId === "case-r2b3")?.personId).toBe("r2b3-alice");
  });

  it("rejects eve granting over alice's case id", async () => {
    const alice = personStub("r2b3-alice2");
    const eve = personStub("r2b3-eve2");
    const org = orgStub("r2b3-county2");
    const orgAgentId = "org:r2b3-county2";

    const grant = await alice.grantConsent("r2b3-alice2", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r2b3b",
    });
    expect(await alice.approve(grant.approval!.id, "r2b3-alice2")).toMatchObject({ status: "completed" });

    const hijack = await eve.grantConsent("r2b3-eve2", {
      orgAgentId,
      purpose: "snooping",
      scope: ["all"],
      caseId: "case-r2b3b",
    });
    expect(hijack.status).toBe("needs_approval");
    expect(await eve.approve(hijack.approval!.id, "r2b3-eve2")).toMatchObject({ status: "blocked" });
    const cases = await org.listCases("r2b3-county2");
    expect(cases.find((c) => c.caseId === "case-r2b3b")).toMatchObject({
      personId: "r2b3-alice2",
      purpose: "renewal",
    });
  });
});
