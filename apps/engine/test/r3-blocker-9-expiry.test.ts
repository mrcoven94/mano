import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 3, blocker 9 through real agents: consent expiry is carried in
// the signed grant, stored by the org, and enforced on delivery and
// every later read. Expiry is not revocation: the case can be shared
// again with a fresh expiry.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r3 blocker 9: consent expiry end to end", () => {
  it("refuses a grant whose expiry already passed", async () => {
    const person = personStub("r3b9-past");
    const past = new Date(Date.now() - 1000).toISOString();
    const result = await person.grantConsent("r3b9-past", {
      orgAgentId: "org:r3b9-county",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b9-past",
      expiresAt: past,
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/expir/i);
  });

  it("rejects delivery when the grant expires before approval", async () => {
    const person = personStub("r3b9-late");
    const org = orgStub("r3b9-late-county");
    const grant = await person.grantConsent("r3b9-late", {
      orgAgentId: "org:r3b9-late-county",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b9-late",
      expiresAt: new Date(Date.now() + 600).toISOString(),
    });
    expect(grant.status).toBe("needs_approval");
    await new Promise((r) => setTimeout(r, 1200));
    const done = await person.approve(grant.approval!.id, "r3b9-late");
    expect(done.status).toBe("blocked");
    expect((await org.listCases("r3b9-late-county")).map((c) => c.caseId)).not.toContain("case-r3b9-late");
  });

  it("drops expired cases from later reads but keeps live ones", async () => {
    const person = personStub("r3b9-reads");
    const org = orgStub("r3b9-reads-county");
    const orgAgentId = "org:r3b9-reads-county";
    const live = await person.grantConsent("r3b9-reads", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b9-live",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const liveDone = await person.approve(live.approval!.id, "r3b9-reads");
    expect(liveDone.status, liveDone.reason).toBe("completed");
    const brief = await person.grantConsent("r3b9-reads", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b9-brief",
      expiresAt: new Date(Date.now() + 600).toISOString(),
    });
    const briefDone = await person.approve(brief.approval!.id, "r3b9-reads");
    expect(briefDone.status, briefDone.reason).toBe("completed");
    expect((await org.listCases("r3b9-reads-county")).map((c) => c.caseId)).toEqual(
      expect.arrayContaining(["case-r3b9-live", "case-r3b9-brief"]),
    );

    await new Promise((r) => setTimeout(r, 1500));
    const cases = (await org.listCases("r3b9-reads-county")).map((c) => c.caseId);
    expect(cases).toContain("case-r3b9-live");
    expect(cases).not.toContain("case-r3b9-brief");
  });

  it("shares an expired case again with a fresh expiry", async () => {
    const person = personStub("r3b9-again");
    const org = orgStub("r3b9-again-county");
    const orgAgentId = "org:r3b9-again-county";
    const input = {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b9-again",
      expiresAt: new Date(Date.now() + 600).toISOString(),
    };
    const first = await person.grantConsent("r3b9-again", input);
    const firstDone = await person.approve(first.approval!.id, "r3b9-again");
    expect(firstDone.status, firstDone.reason).toBe("completed");
    await new Promise((r) => setTimeout(r, 1500));
    expect((await org.listCases("r3b9-again-county")).map((c) => c.caseId)).not.toContain("case-r3b9-again");

    const freshExpiry = new Date(Date.now() + 3600_000).toISOString();
    const second = await person.grantConsent("r3b9-again", { ...input, expiresAt: freshExpiry });
    expect(second.status).toBe("needs_approval");
    expect(second.approval!.idempotencyKey).toBe(`consent-grant:r3b9-again:case-r3b9-again:${freshExpiry}`);
    const secondDone = await person.approve(second.approval!.id, "r3b9-again");
    expect(secondDone.status, secondDone.reason).toBe("completed");
    expect((await org.listCases("r3b9-again-county")).map((c) => c.caseId)).toContain("case-r3b9-again");
  });
});
