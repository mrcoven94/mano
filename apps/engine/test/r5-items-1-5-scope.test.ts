import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 5, items 1 and 5 through real agents: a reconcile consults for
// one sender's message of one type. Keys are caller-controlled, so Eve
// can deliver her own share under Alice's undelivered revoke key; that
// foreign record must not satisfy Alice's revoke reconcile, and a grant
// must not satisfy a revoke consult under the same key.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r5 items 1 and 5: scoped revoke reconciliation", () => {
  it("two people, same key: the second delivery must not satisfy the first", async () => {
    const alice = personStub("r5s1-alice");
    const eve = personStub("r5s1-eve");
    const org = orgStub("r5s1-county");
    const orgAgentId = "org:r5s1-county";

    const grant = await alice.grantConsent("r5s1-alice", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r5s1-alice",
    });
    const granted = await alice.approve(grant.approval!.id, "r5s1-alice");
    expect(granted.status, granted.reason).toBe("completed");

    // Alice's revoke is approved but not yet delivered; its key is visible.
    const revoke = await alice.revokeConsent("r5s1-alice", { orgAgentId, caseId: "case-r5s1-alice" });
    expect(revoke.status).toBe("needs_approval");
    const revokeKey = revoke.approval!.idempotencyKey;

    // Eve approves her own share reusing Alice's revoke key.
    const eveShare: ActionRequest = {
      type: "share",
      recipient: orgAgentId,
      purpose: "renewal",
      payload: { consent: "grant", caseId: "case-r5s1-eve", scope: ["documents"] },
      idempotencyKey: revokeKey,
      actor: "foreground",
      personId: "r5s1-eve",
      sources: [{ kind: "profile", id: "r5s1-eve" }],
      origin: "person",
    };
    const eveReq = await eve.requestAction(eveShare, "r5s1-eve");
    expect(eveReq.status).toBe("needs_approval");
    const eveDone = await eve.approve(eveReq.approval!.id, "r5s1-eve");
    expect(eveDone.status, eveDone.reason).toBe("completed");

    // Eve's record satisfies Eve's own grant reconcile only.
    expect(await org.hasConsentRecord("person:r5s1-eve", revokeKey, "share")).toBe(true);
    expect(await org.hasConsentRecord("person:r5s1-eve", revokeKey, "revoke")).toBe(false);
    // Alice's undelivered revoke reconciles as not found, not completed.
    expect(await org.hasConsentRecord("person:r5s1-alice", revokeKey, "revoke")).toBe(false);
    expect((await org.listCases("r5s1-county")).map((c) => c.caseId)).toContain("case-r5s1-alice");

    // Alice's own revoke still delivers beside Eve's record.
    const revoked = await alice.approve(revoke.approval!.id, "r5s1-alice");
    expect(revoked.status, revoked.reason).toBe("completed");
    expect(await org.hasConsentRecord("person:r5s1-alice", revokeKey, "revoke")).toBe(true);
    const cases = (await org.listCases("r5s1-county")).map((c) => c.caseId);
    expect(cases).not.toContain("case-r5s1-alice");
    expect(cases).toContain("case-r5s1-eve");
  });
});
