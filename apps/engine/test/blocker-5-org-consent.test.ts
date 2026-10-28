import { env as testEnv, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function personToken(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

async function staffToken(sub: string, org: string): Promise<string> {
  return mintSessionToken({ kind: "staff", sub, org }, TEST_SESSION_SECRET);
}

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function orgStub(name: string): OrgAgent {
  const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as OrgAgent;
}

describe("blocker 5: org cases need staff auth and append-only revocation", () => {
  it("rejects unauthenticated org reads", async () => {
    const res = await SELF.fetch("https://mano.test/api/orgs/b5county/cases");
    expect(res.status).toBe(403);
  });

  it("rejects a person token on an org route", async () => {
    const token = await personToken("b5maria");
    const res = await SELF.fetch("https://mano.test/api/orgs/b5county/cases", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a staff token for a different org", async () => {
    const token = await staffToken("worker-1", "other-county");
    const res = await SELF.fetch("https://mano.test/api/orgs/b5county/cases", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("lets staff reach their own org", async () => {
    const token = await staffToken("worker-1", "b5county");
    const res = await SELF.fetch("https://mano.test/api/orgs/b5county/cases", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("keeps a revoked case revoked when it is shared again", async () => {
    // Stub name and verified subject match, as the worker always routes.
    const person = personStub("b5flow");
    const org = orgStub("b5county");
    const orgAgentId = "org:b5county";
    const grant = { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-b5" };

    const g1 = await person.grantConsent("b5flow", grant);
    expect(g1.status).toBe("needs_approval");
    const a1 = await person.approve(g1.approval!.id, "b5flow");
    expect(a1.status).toBe("completed");
    expect((await org.listCases("b5county")).map((c) => c.caseId)).toContain("case-b5");

    const r1 = await person.revokeConsent("b5flow", { orgAgentId, caseId: "case-b5" });
    expect(r1.status).toBe("needs_approval");
    const a2 = await person.approve(r1.approval!.id, "b5flow");
    expect(a2.status).toBe("completed");
    expect((await org.listCases("b5county")).map((c) => c.caseId)).not.toContain("case-b5");

    const second = await person.grantConsent("b5flow", grant);
    expect(second.status).toBe("blocked");
    expect(second.reason).toMatch(/revoked/i);
    expect((await org.listCases("b5county")).map((c) => c.caseId)).not.toContain("case-b5");
  });
});
