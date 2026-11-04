import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Item 9: revocation deletes the person's consent row by case and
// recipient. After a revoke, the checker no longer sees consent for that
// recipient and purpose.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

describe("r2 item 9: revocation clears the consent the checker sees", () => {
  it("flags a new share as uncovered after the old consent was revoked", async () => {
    const person = personStub("r2i9-maria");
    const orgAgentId = "org:r2i9-county";
    const grant = { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-r2i9" };
    const g1 = await person.grantConsent("r2i9-maria", grant);
    expect(await person.approve(g1.approval!.id, "r2i9-maria")).toMatchObject({ status: "completed" });
    const r1 = await person.revokeConsent("r2i9-maria", { orgAgentId, caseId: "case-r2i9" });
    expect(await person.approve(r1.approval!.id, "r2i9-maria")).toMatchObject({ status: "completed" });

    const g2 = await person.grantConsent("r2i9-maria", { ...grant, caseId: "case-r2i9-second" });
    expect(g2.status).toBe("needs_approval");
    expect(g2.approval!.problems.join(" ")).toMatch(/no recorded consent/i);
  });
});
