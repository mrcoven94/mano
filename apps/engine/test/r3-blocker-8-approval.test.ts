import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 3, blocker 8 through real agents: two identical grant requests
// share one idempotency key. Approving the second approval still finds
// the exact consumed approval instead of stranding on the first row.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r3 blocker 8: identical requests do not strand the approval", () => {
  it("delivers when the second of two identical approvals is approved", async () => {
    const person = personStub("r3b8-maria");
    const org = orgStub("r3b8-county");
    const orgAgentId = "org:r3b8-county";
    const grant = { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-r3b8" };
    const first = await person.grantConsent("r3b8-maria", grant);
    const second = await person.grantConsent("r3b8-maria", grant);
    expect(first.status).toBe("needs_approval");
    expect(second.status).toBe("needs_approval");
    expect(second.approval!.idempotencyKey).toBe(first.approval!.idempotencyKey);

    const done = await person.approve(second.approval!.id, "r3b8-maria");
    expect(done.status, done.reason).toBe("completed");
    expect((await org.listCases("r3b8-county")).map((c) => c.caseId)).toContain("case-r3b8");
  });
});
