import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 3, blocker 6 through real agents: consent outcomes from a share
// receipt apply idempotently, so recovery-time application is safe.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r3 blocker 6: share outcomes apply idempotently", () => {
  it("re-applies a completed grant outcome without duplicating", async () => {
    const person = personStub("r3b6-share");
    const org = orgStub("r3b6-share-county");
    const orgAgentId = "org:r3b6-share-county";
    const grant = await person.grantConsent("r3b6-share", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b6-share",
    });
    const done = await person.approve(grant.approval!.id, "r3b6-share");
    expect(done.status).toBe("completed");
    const key = done.receipt!.idempotencyKey;

    // What recovery runs after it executes a stranded share: same effect,
    // safe to repeat.
    await person.applyShareOutcome(key);
    await person.applyShareOutcome(key);
    const cases = await org.listCases("r3b6-share-county");
    expect(cases.filter((c) => c.caseId === "case-r3b6-share")).toHaveLength(1);

    // And the checker still sees the consent covered.
    const probe = await person.grantConsent("r3b6-share", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r3b6-probe",
    });
    expect(probe.status).toBe("needs_approval");
    expect(probe.approval!.problems.join(" ")).not.toMatch(/no recorded consent/i);
  });
});
