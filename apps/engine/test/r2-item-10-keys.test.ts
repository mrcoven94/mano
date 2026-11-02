import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@mano/protocol";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Item 10: agent keypairs are created once in the constructor, so two
// first calls cannot generate two keys; and the org pins its own ID only
// after a signature verifies.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("r2 item 10: single keypair and verified org pinning", () => {
  it("returns one keypair from concurrent first calls on a person agent", async () => {
    const person = personStub(`r2i10-person-${crypto.randomUUID()}`);
    const keys = await Promise.all([person.getPublicKey(), person.getPublicKey(), person.getPublicKey()]);
    expect(new Set(keys).size).toBe(1);
  });

  it("returns one keypair from concurrent first calls on an org agent", async () => {
    const org = orgStub(`r2i10-org-${crypto.randomUUID()}`);
    const keys = await Promise.all([org.getPublicKey(), org.getPublicKey()]);
    expect(new Set(keys).size).toBe(1);
  });

  it("does not pin the org ID from an unverified message", async () => {
    const org = orgStub("r2i10-fresh");
    const poison = {
      id: "poison-1",
      version: PROTOCOL_VERSION,
      type: "consent.grant",
      caseId: "case-poison",
      fromAgentId: "person:ghost",
      toAgentId: "org:r2i10-wrong",
      payload: { orgAgentId: "org:r2i10-wrong", purpose: "x", scope: [] },
      sources: [],
      approvedByHumanId: "ghost",
      idempotencyKey: "poison-key",
      createdAt: new Date().toISOString(),
      signature: "not-a-signature",
      signerPublicKey: "not-a-key",
    };
    const rejected = await org.receiveConsent(poison);
    expect(rejected.accepted).toBe(false);

    // A later valid grant to this org's own address still lands.
    const person = personStub("r2i10-maria");
    const grant = await person.grantConsent("r2i10-maria", {
      orgAgentId: "org:r2i10-fresh",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r2i10",
    });
    expect(await person.approve(grant.approval!.id, "r2i10-maria")).toMatchObject({ status: "completed" });
    expect((await org.listCases("r2i10-fresh")).map((c) => c.caseId)).toContain("case-r2i10");
  });
});
