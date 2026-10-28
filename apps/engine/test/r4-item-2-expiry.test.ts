import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Round 4, item 2 through a real agent: the reorder that lets consumed
// approvals reconcile after expiry must not change pending approvals,
// which still expire and block.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

describe("r4 item 2: pending approvals still expire", () => {
  it("blocks approving a pending approval past its window", async () => {
    const person = personStub("r4i2-pending");
    const grant = await person.grantConsent("r4i2-pending", {
      orgAgentId: "org:r4i2-county",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r4i2-pending",
    });
    expect(grant.status).toBe("needs_approval");

    const swept = await person.processDueApprovals({
      approvalId: grant.approval!.id,
      now: new Date(Date.now() + 48 * 3600_000).toISOString(),
    });
    expect(swept.expired).toContain(grant.approval!.id);

    const done = await person.approve(grant.approval!.id, "r4i2-pending");
    expect(done.status).toBe("blocked");
    expect(done.reason).toMatch(/expired/i);
  });
});
