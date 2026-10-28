import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Re-review blocker 5: consent uses deterministic keys, the signed message
// is stored once per key and resent verbatim, and the org dedupes on
// sender plus key. Consent is never delivered twice.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

// deliverShare is agent-internal (no HTTP route reaches it); the test
// calls it to simulate the gateway retrying a share delivery.
type ShareDeliverer = { deliverShare(req: ActionRequest): Promise<{ externalId: string }> };

describe("r2 blocker 5: consent is delivered exactly once", () => {
  it("uses a deterministic key per person, case and direction", async () => {
    const person = personStub("r2b5-maria");
    const grant = { orgAgentId: "org:r2b5-county", purpose: "renewal", scope: ["documents"], caseId: "case-r2b5" };
    const first = await person.grantConsent("r2b5-maria", grant);
    const second = await person.grantConsent("r2b5-maria", grant);
    expect(first.status).toBe("needs_approval");
    expect(second.status).toBe("needs_approval");
    expect(first.approval!.idempotencyKey).toBe("consent-grant:r2b5-maria:case-r2b5");
    expect(second.approval!.idempotencyKey).toBe(first.approval!.idempotencyKey);
  });

  it("resends the same signed message when a share delivery retries", async () => {
    const person = personStub("r2b5-retry");
    const org = orgStub("r2b5-retry-county");
    const orgAgentId = "org:r2b5-retry-county";
    const grant = await person.grantConsent("r2b5-retry", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r2b5-retry",
    });
    const approved = await person.approve(grant.approval!.id, "r2b5-retry");
    expect(approved.status).toBe("completed");

    const req: ActionRequest = {
      type: "share",
      recipient: orgAgentId,
      purpose: "renewal",
      payload: { consent: "grant", caseId: "case-r2b5-retry", scope: ["documents"] },
      idempotencyKey: grant.approval!.idempotencyKey,
      actor: "foreground",
      personId: "r2b5-retry",
      sources: [],
      origin: "person",
    };
    const again = await (person as unknown as ShareDeliverer).deliverShare(req);
    const firstId = approved.receipt!.externalId;
    expect(again.externalId).toBe(firstId);
    expect((await org.listCases("r2b5-retry-county")).filter((c) => c.caseId === "case-r2b5-retry")).toHaveLength(1);
  });

  it("treats concurrent redeliveries as duplicates of one message", async () => {
    const person = personStub("r2b5-race");
    const orgAgentId = "org:r2b5-race-county";
    const grant = await person.grantConsent("r2b5-race", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r2b5-race",
    });
    expect(await person.approve(grant.approval!.id, "r2b5-race")).toMatchObject({ status: "completed" });
    const req: ActionRequest = {
      type: "share",
      recipient: orgAgentId,
      purpose: "renewal",
      payload: { consent: "grant", caseId: "case-r2b5-race", scope: ["documents"] },
      idempotencyKey: grant.approval!.idempotencyKey,
      actor: "foreground",
      personId: "r2b5-race",
      sources: [],
      origin: "person",
    };
    const deliver = person as unknown as ShareDeliverer;
    // Both resend the one stored message; the org already recorded it.
    const [a, b] = await Promise.all([deliver.deliverShare(req), deliver.deliverShare(req)]);
    expect(a.externalId).toBe(b.externalId);
  });

  it("refuses a re-grant after a revoke without contacting the org again", async () => {
    const person = personStub("r2b5-terminal");
    const orgAgentId = "org:r2b5-terminal-county";
    const grant = { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-r2b5t" };
    const g1 = await person.grantConsent("r2b5-terminal", grant);
    expect(await person.approve(g1.approval!.id, "r2b5-terminal")).toMatchObject({ status: "completed" });
    const r1 = await person.revokeConsent("r2b5-terminal", { orgAgentId, caseId: "case-r2b5t" });
    expect(await person.approve(r1.approval!.id, "r2b5-terminal")).toMatchObject({ status: "completed" });
    const second = await person.grantConsent("r2b5-terminal", grant);
    expect(second.status).toBe("blocked");
    expect(second.reason).toMatch(/revoked/i);
  });
});
