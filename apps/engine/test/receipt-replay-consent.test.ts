import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureAppliedEffects, type PersonAgent } from "../src/agents/person-agent.js";

// LAP-747 follow-up. Engine answers a repeated approve with the receipt it
// already has. That answer is marked replayed, and the person's agent
// applies no effects for it, so replaying the approval of a consent grant
// after its revocation never restores the revoked consent.
function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

async function consents(name: string) {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return runInDurableObject(ns.get(ns.idFromName(name)), (_i, state) =>
    state.storage.sql.exec("SELECT recipient, case_id FROM consents").toArray() as { recipient: string; case_id: string }[],
  );
}

describe("LAP-747: a replayed approval never re-applies its effects", () => {
  it("replaying the approval of a revoked consent grant answers its receipt and leaves the consent revoked", async () => {
    const name = "lap747-replay-consent";
    const person = personStub(name);
    const orgAgentId = "org:lap747-replay-county";
    const grant = await person.grantConsent(name, { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-lap747" });
    const granted = await person.approve(grant.approval!.id, name);
    expect(granted.status, granted.reason).toBe("completed");
    expect(await consents(name)).toHaveLength(1);

    const revoke = await person.revokeConsent(name, { orgAgentId, caseId: "case-lap747" });
    expect((await person.approve(revoke.approval!.id, name)).status).toBe("completed");
    expect(await consents(name)).toHaveLength(0);

    const replay = await person.approve(grant.approval!.id, name);
    expect(replay).toMatchObject({ status: "completed", replayed: true, receipt: { externalId: granted.receipt!.externalId } });
    expect(await consents(name)).toHaveLength(0);
  });
});

// Review round 11: grant G is unknown; retries A and B reconcile it
// together; B completes G; the revocation completes; then A's delayed
// lookup finds G and answers reconciled, with no flag. The effect is
// applied once per key, so the consent stays revoked.
describe("LAP-747: a consent effect is applied at most once per filing", () => {
  it("A's late reconcile of grant G after the revocation applies nothing", async () => {
    const name = "lap747-late-reconcile";
    const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
    const person = personStub(name);
    const orgAgentId = "org:lap747-late-county";
    const grant = await person.grantConsent(name, { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-lap747-late" });
    const key = grant.approval!.idempotencyKey;
    expect((await person.approve(grant.approval!.id, name)).status).toBe("completed");
    const revoke = await person.revokeConsent(name, { orgAgentId, caseId: "case-lap747-late" });
    expect((await person.approve(revoke.approval!.id, name)).status).toBe("completed");
    expect(await consents(name)).toHaveLength(0);

    // A read G as unknown before B completed it: its retry reconciles.
    await runInDurableObject(ns.get(ns.idFromName(name)), (instance) => {
      (instance as unknown as { store: { updateAttempt(k: string, s: string): void } }).store.updateAttempt(key, "unknown");
    });
    const late = await person.approve(grant.approval!.id, name);
    expect(late.status).toBe("reconciled");
    expect(late.replayed).toBeUndefined();
    expect(await consents(name)).toHaveLength(0);

  });
});

// Review round 12: a Durable Object from before applied_effects existed.
// Grant G and revoke R completed under the old code (their effects ran
// when their receipts were recorded); the deploy creates the table; then
// G's approval is replayed. The migration marks both as applied.
describe("LAP-747: the applied-effects migration counts receipts already on file", () => {
  it("after the migration, replaying a pre-deploy grant applies nothing", async () => {
    const name = "lap747-migration";
    const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
    const person = personStub(name);
    const orgAgentId = "org:lap747-migration-county";
    const grant = await person.grantConsent(name, { orgAgentId, purpose: "renewal", scope: ["documents"], caseId: "case-lap747-mig" });
    expect((await person.approve(grant.approval!.id, name)).status).toBe("completed");
    const revoke = await person.revokeConsent(name, { orgAgentId, caseId: "case-lap747-mig" });
    expect((await person.approve(revoke.approval!.id, name)).status).toBe("completed");
    expect(await consents(name)).toHaveLength(0);

    // As before the deploy: no applied_effects table at all. Then the
    // migration runs, twice, as on every start.
    const marked = await runInDurableObject(ns.get(ns.idFromName(name)), (_i, state) => {
      state.storage.sql.exec("DROP TABLE applied_effects");
      ensureAppliedEffects(state.storage);
      ensureAppliedEffects(state.storage);
      return state.storage.sql.exec("SELECT idempotency_key FROM applied_effects ORDER BY idempotency_key").toArray().map((r) => (r as { idempotency_key: string }).idempotency_key);
    });
    expect(marked.sort()).toEqual([grant.approval!.idempotencyKey, revoke.approval!.idempotencyKey].sort());

    const replay = await person.approve(grant.approval!.id, name);
    expect(replay.status).toBe("completed");
    expect(await consents(name)).toHaveLength(0);
  });
});
