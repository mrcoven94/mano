import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActionGateway, MemoryApprovalStore, TimeoutError } from "../src/gateway/index.js";
import type { ActionRequest, CheckOutcome, Executor } from "../src/gateway/index.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";

// LAP-747 follow-up. Recovery decides a stranded filing's fate after
// awaited lookups and checks. Every failed write it makes is guarded by
// the attempt's version read before them, so a YES that adopted and filed
// the key meanwhile keeps its outcome and its receipt.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Each lookup and post waits until the test releases it.
class ScriptedPortal implements Executor {
  readonly simulated = true;
  posts: ActionRequest[] = [];
  lookups: ReturnType<typeof deferred<CheckOutcome>>[] = [];
  filings: ReturnType<typeof deferred<{ externalId: string }>>[] = [];
  execute(req: ActionRequest) {
    this.posts.push(req);
    const d = deferred<{ externalId: string }>();
    this.filings.push(d);
    return d.promise;
  }
  check() {
    const d = deferred<CheckOutcome>();
    this.lookups.push(d);
    return d.promise;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const later = () => new Date(Date.now() + 60_000).toISOString();

const proposal = () => ({
  type: "submit",
  recipient: "sandbox-agency-portal",
  purpose: "Food benefits renewal in the sandbox agency portal",
  payload: { phone: "253-555-0100" },
  idempotencyKey: `agent:g0:${crypto.randomUUID()}:d0`,
  actor: "foreground",
  personId: "person-maria",
});

// An approved filing that timed out with the portal unreachable: unknown.
async function unknownFiling(checker?: { check(): Promise<{ verdict: "pass" | "block"; problems: string[] }> }) {
  const portal = new ScriptedPortal();
  const store = new MemoryApprovalStore();
  const gateway = new ActionGateway(store, portal, checker ? { checker } : {});
  const held = await gateway.requestAction(proposal());
  const first = gateway.approveAndExecute(held.approval!.id, "person-maria");
  await tick();
  portal.filings[0]!.reject(new TimeoutError());
  await tick();
  portal.lookups[0]!.reject(new Error("portal unreachable"));
  await first;
  expect(store.getAttempt(held.approval!.idempotencyKey)?.status).toBe("unknown");
  return { portal, store, gateway, approval: held.approval! };
}

describe("LAP-747: recovery never fails an attempt another request moved", () => {
  it("recovery's checker blocks after a YES found it absent and started filing: RECEIVED-1 stands", async () => {
    let block = false;
    const checker = { check: async () => (block ? { verdict: "block" as const, problems: ["held"] } : { verdict: "pass" as const, problems: [] }) };
    const { portal, store, gateway, approval } = await unknownFiling(checker);
    const recovery = gateway.recoverAttempt(approval.idempotencyKey, new Date(), later());
    await tick();
    const yes = gateway.approveAndExecute(approval.id, "person-maria");
    await tick();
    portal.lookups[2]!.resolve({ found: false });
    await tick();
    expect(portal.posts).toHaveLength(2);
    block = true;
    portal.lookups[1]!.resolve({ found: false });
    expect((await recovery)?.status).toBe("in_progress");
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("in_flight");
    portal.filings[1]!.resolve({ externalId: "RECEIVED-1" });
    expect(await yes).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("done");
  });

  it("recovery's late failure after a receipt landed answers the receipt, never failed", async () => {
    const checker = { check: async () => ({ verdict: "block" as const, problems: ["held"] }) };
    const { portal, store, approval } = await unknownFiling();
    const blocked = new ActionGateway(store, portal, { checker });
    const recovery = blocked.recoverAttempt(approval.idempotencyKey, new Date(), later());
    await tick();
    store.putReceipt({
      id: "r1", idempotencyKey: approval.idempotencyKey, actionType: "submit", recipient: "sandbox-agency-portal",
      status: "completed", externalId: "RECEIVED-1", simulated: true, requestHash: "", createdAt: new Date().toISOString(),
    });
    store.updateAttempt(approval.idempotencyKey, "done");
    portal.lookups.at(-1)!.resolve({ found: false });
    expect(await recovery).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("done");
  });

  it("a stranded in_flight attempt (a Worker restart) can still be failed by recovery at the version it claimed", async () => {
    const checker = { check: async () => ({ verdict: "block" as const, problems: ["held"] }) };
    const { portal, store, approval } = await unknownFiling();
    // As a restart leaves it: claimed for execution, nothing running.
    store.updateAttempt(approval.idempotencyKey, "in_flight");
    const recovery = new ActionGateway(store, portal, { checker }).recoverAttempt(approval.idempotencyKey, new Date(), later());
    await tick();
    portal.lookups.at(-1)!.resolve({ found: false });
    expect(await recovery).toMatchObject({ status: "blocked" });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("failed");
    expect(portal.posts).toHaveLength(1);
  });

  it("Engine's SQL store bumps the version on every write and fails an attempt only at the version read", async () => {
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName("lap747-version"));
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      ensureGatewayTables(sql);
      const store = new SqlApprovalStore(sql);
      const base = { status: "unknown", updatedAt: "2026-11-03T00:00:00.000Z", requestHash: "h", actionType: "submit", recipient: "r", personId: "p" } as const;
      store.insertAttempt({ ...base, key: "k1" });
      const read = store.getAttempt("k1")!.version!;
      store.updateAttempt("k1", "unknown");
      expect(store.getAttempt("k1")!.version).toBe(read + 1);
      expect(store.failAttemptAt("k1", read)).toBe(false);
      expect(store.getAttempt("k1")!.status).toBe("unknown");
      expect(store.failAttemptAt("k1", read + 1)).toBe(true);
      expect(store.getAttempt("k1")!.status).toBe("failed");

      store.insertAttempt({ ...base, key: "k2" });
      store.putReceipt({
        id: "r2", idempotencyKey: "k2", actionType: "submit", recipient: "r", status: "reconciled",
        externalId: "RECEIVED-2", simulated: true, requestHash: "h", createdAt: new Date().toISOString(),
      });
      expect(store.failAttemptAt("k2", store.getAttempt("k2")!.version!)).toBe(false);
    });
  });
});
