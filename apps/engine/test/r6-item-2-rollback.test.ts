import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { OrgAgent } from "../src/agents/org-agent.js";

// Round 6, item 2 through real agents: a consent delivery whose event
// append fails mid-transaction leaves no delivery marker and no event in
// the org's SQLite, so the retry applies the event instead of reading a
// marker as done. The failure is a real SQLite abort raised by a trigger
// on case_events, the exact write the transaction must roll back.

function stubFor(ns: DurableObjectNamespace, name: string) {
  return ns.get(ns.idFromName(name));
}

function count(state: DurableObjectState, query: string, ...bindings: unknown[]): number {
  return (state.storage.sql.exec(query, ...bindings).toArray()[0] as { n: number }).n;
}

describe("r6 item 2: real-agent consent rollback", () => {
  it("persists nothing partial when the event append fails, then the retry applies once", async () => {
    const personStub = stubFor(testEnv.PERSON_AGENT as DurableObjectNamespace, "r6i2-alice");
    const orgStub = stubFor(testEnv.ORG_AGENT as DurableObjectNamespace, "r6i2-county");
    const alice = personStub as unknown as PersonAgent;
    const org = orgStub as unknown as OrgAgent;
    const orgAgentId = "org:r6i2-county";

    // Opens the org agent so its tables exist, then arms the failure.
    await org.getPublicKey();
    await runInDurableObject(orgStub, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER r6i2_fail_append BEFORE INSERT ON case_events BEGIN SELECT RAISE(ABORT, 'forced append failure'); END",
      );
    });

    const grant = await alice.grantConsent("r6i2-alice", {
      orgAgentId,
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r6i2",
    });
    expect(grant.status).toBe("needs_approval");
    const key = grant.approval!.idempotencyKey;
    const failed = await alice.approve(grant.approval!.id, "r6i2-alice");
    expect(failed.status).toBe("blocked");

    await runInDurableObject(orgStub, (_instance, state) => {
      expect(count(state, "SELECT COUNT(*) AS n FROM processed_messages WHERE idempotency_key = ?", key)).toBe(0);
      expect(count(state, "SELECT COUNT(*) AS n FROM case_events WHERE case_id = 'case-r6i2'")).toBe(0);
      state.storage.sql.exec("DROP TRIGGER r6i2_fail_append");
    });
    expect(await org.hasConsentRecord("person:r6i2-alice", key, "share")).toBe(false);

    const retried = await alice.approve(grant.approval!.id, "r6i2-alice");
    expect(retried.status, retried.reason).toBe("completed");
    await runInDurableObject(orgStub, (_instance, state) => {
      expect(count(state, "SELECT COUNT(*) AS n FROM processed_messages WHERE idempotency_key = ?", key)).toBe(1);
      expect(count(state, "SELECT COUNT(*) AS n FROM case_events WHERE case_id = 'case-r6i2'")).toBe(1);
    });
    expect((await org.listCases("r6i2-county")).map((c) => c.caseId)).toEqual(["case-r6i2"]);
  });
});
