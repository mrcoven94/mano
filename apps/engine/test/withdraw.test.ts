import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActionGateway, MemoryApprovalStore, TimeoutError } from "../src/gateway/index.js";
import type { ActionRequest, CheckOutcome, Executor } from "../src/gateway/index.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";

// LAP-747 follow-up. Maria approves a renewal, its filing times out and
// the portal cannot be asked, then she corrects her phone number. Mano
// withdraws the approved one: from then on Engine only reconciles it, so a
// later YES or recovery that finds it never happened ends it and never
// files the old phone. Reconcile still comes first, and a withdrawn filing
// that did go through still answers its receipt.
class Portal implements Executor {
  readonly simulated = true;
  posts: ActionRequest[] = [];
  filed = new Map<string, string>();
  checkDown = true;
  // Times out without filing on the first post.
  dropFirst = true;
  // Files, then times out, on the first post.
  fileThenTimeOut = false;
  async execute(req: ActionRequest) {
    this.posts.push(req);
    if (this.posts.length === 1 && this.fileThenTimeOut) {
      this.filed.set(req.idempotencyKey, "WA-1");
      throw new TimeoutError();
    }
    if (this.posts.length === 1 && this.dropFirst) throw new TimeoutError();
    const id = `WA-${this.posts.length}`;
    this.filed.set(req.idempotencyKey, id);
    return { externalId: id };
  }
  async check(key: string): Promise<CheckOutcome> {
    if (this.checkDown) throw new Error("portal unreachable");
    const id = this.filed.get(key);
    return id ? { found: true, externalId: id } : { found: false };
  }
}

const proposal = () => ({
  type: "submit",
  recipient: "sandbox-agency-portal",
  purpose: "Food benefits renewal in the sandbox agency portal",
  payload: { phone: "253-555-0100" },
  idempotencyKey: `agent:g0:${crypto.randomUUID()}:d0`,
  actor: "foreground",
  personId: "person-maria",
});

async function approvedAndUnknown(portal = new Portal()) {
  const store = new MemoryApprovalStore();
  const gateway = new ActionGateway(store, portal);
  const held = await gateway.requestAction(proposal());
  const first = await gateway.approveAndExecute(held.approval!.id, "person-maria");
  expect(first.status).toBe("blocked");
  expect(store.getAttempt(held.approval!.idempotencyKey)?.status).toBe("unknown");
  return { store, gateway, portal, approval: held.approval! };
}

describe("LAP-747: a withdrawn approval is reconciled, never run again", () => {
  it("a YES after the correction reconciles first, and confirmed absent ends it without filing the old values", async () => {
    const { store, gateway, portal, approval } = await approvedAndUnknown();
    const withdrawn = await gateway.withdrawApproval(approval.id, "person-maria");
    expect(withdrawn).toMatchObject({ status: "rejected", withdrawn: true });

    // The portal still cannot be asked: nothing runs, the attempt stays unknown.
    const unreachable = await gateway.approveAndExecute(approval.id, "person-maria");
    expect(unreachable.status).toBe("blocked");
    expect(unreachable.withdrawn).toBeUndefined();
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("unknown");

    portal.checkDown = false;
    const ended = await gateway.approveAndExecute(approval.id, "person-maria");
    expect(ended).toMatchObject({ status: "blocked", withdrawn: true });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("failed");
    expect(portal.posts).toHaveLength(1);
    expect((await gateway.approveAndExecute(approval.id, "person-maria")).withdrawn).toBe(true);
    expect(portal.posts).toHaveLength(1);
  });

  it("a withdrawn filing that did go through still answers its receipt", async () => {
    const portal = new Portal();
    portal.fileThenTimeOut = true;
    const { gateway, approval } = await approvedAndUnknown(portal);
    await gateway.withdrawApproval(approval.id, "person-maria");
    portal.checkDown = false;
    const found = await gateway.approveAndExecute(approval.id, "person-maria");
    expect(found.status).toBe("reconciled");
    expect(found.receipt?.externalId).toBe("WA-1");
    expect(portal.posts).toHaveLength(1);
    expect(await gateway.withdrawApproval(approval.id, "person-maria")).toMatchObject({ status: "completed" });
  });

  it("recovery of a withdrawn approval reconciles and ends it, never executes", async () => {
    const { store, gateway, portal, approval } = await approvedAndUnknown();
    await gateway.withdrawApproval(approval.id, "person-maria");
    portal.checkDown = false;
    const recovered = await gateway.recoverAttempt(approval.idempotencyKey, new Date(), new Date(Date.now() + 60_000).toISOString());
    expect(recovered).toMatchObject({ status: "blocked", withdrawn: true });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("failed");
    expect(portal.posts).toHaveLength(1);
  });

  it("without a withdrawal, the same approval still retries after a confirmed absent, as before", async () => {
    const { gateway, portal, approval } = await approvedAndUnknown();
    portal.checkDown = false;
    const retried = await gateway.approveAndExecute(approval.id, "person-maria");
    expect(retried.status).toBe("completed");
    expect(portal.posts).toHaveLength(2);
  });

  it("only the person's own approved approval can be withdrawn", async () => {
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, new Portal());
    const held = await gateway.requestAction(proposal());
    expect((await gateway.withdrawApproval(held.approval!.id, "person-maria")).status).toBe("blocked");
    const { gateway: g2, approval } = await approvedAndUnknown();
    expect((await g2.withdrawApproval(approval.id, "person-someone-else")).status).toBe("blocked");
    expect((await g2.withdrawApproval("missing", "person-maria")).status).toBe("blocked");
  });

  it("Engine's SQL store keeps the withdrawal", async () => {
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName("lap747-withdraw"));
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      ensureGatewayTables(sql);
      const store = new SqlApprovalStore(sql);
      const base = {
        actionType: "submit", recipient: "sandbox-agency-portal", purpose: "renewal", documentHash: null, documentId: null,
        approvedByHumanId: "person-maria", personId: "person-maria", requestJson: "{}", requestHash: "h", problems: [],
        createdAt: new Date().toISOString(), remindAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), escalated: false,
      } as const;
      store.putApproval({ ...base, id: "waiting", idempotencyKey: "k1", status: "pending" } as never);
      store.putApproval({ ...base, id: "approved", idempotencyKey: "k2", status: "approved" } as never);
      expect(store.withdrawApproval("waiting")).toBe(false);
      expect(store.withdrawApproval("approved")).toBe(true);
      expect(store.withdrawApproval("approved")).toBe(true);
      expect(new SqlApprovalStore(sql).approvalWithdrawn("approved")).toBe(true);
      expect(store.approvalWithdrawn("waiting")).toBe(false);
    });
  });
});

// Two retries reconcile the same unknown attempt at once. Each lookup and
// post waits until the test releases it, so the exact interleaving runs.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

async function unknownWithScriptedPortal() {
  const portal = new ScriptedPortal();
  const store = new MemoryApprovalStore();
  const gateway = new ActionGateway(store, portal);
  const held = await gateway.requestAction(proposal());
  const first = gateway.approveAndExecute(held.approval!.id, "person-maria");
  await tick();
  portal.filings[0]!.reject(new TimeoutError());
  await tick();
  portal.lookups[0]!.reject(new Error("portal unreachable"));
  expect((await first).status).toBe("blocked");
  expect(store.getAttempt(held.approval!.idempotencyKey)?.status).toBe("unknown");
  return { portal, store, gateway, approval: held.approval! };
}

describe("LAP-747: ending a withdrawal never overrides a filing that went through", () => {
  it("A finds it absent and files, Maria withdraws, A records its receipt, then B's late absent: the receipt wins", async () => {
    const { portal, store, gateway, approval } = await unknownWithScriptedPortal();
    const a = gateway.approveAndExecute(approval.id, "person-maria");
    const b = gateway.approveAndExecute(approval.id, "person-maria");
    await tick();
    expect(portal.lookups).toHaveLength(3);
    portal.lookups[1]!.resolve({ found: false });
    await tick();
    expect(portal.posts).toHaveLength(2);
    expect((await gateway.withdrawApproval(approval.id, "person-maria")).withdrawn).toBe(true);
    portal.filings[1]!.resolve({ externalId: "RECEIVED-1" });
    expect(await a).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    portal.lookups[2]!.resolve({ found: false });
    const late = await b;
    expect(late).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    expect(late.withdrawn).toBeUndefined();
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("done");
    expect(portal.posts).toHaveLength(2);
  });

  it("A's filing times out again before B's late absent: B ends nothing, and only a fresh lookup ends it", async () => {
    const { portal, store, gateway, approval } = await unknownWithScriptedPortal();
    const a = gateway.approveAndExecute(approval.id, "person-maria");
    const b = gateway.approveAndExecute(approval.id, "person-maria");
    await tick();
    portal.lookups[1]!.resolve({ found: false });
    await tick();
    await gateway.withdrawApproval(approval.id, "person-maria");
    portal.filings[1]!.reject(new TimeoutError());
    await tick();
    portal.lookups[3]!.reject(new Error("portal unreachable"));
    expect((await a).status).toBe("blocked");
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("unknown");

    // B's lookup began before A's second post, so its absent says nothing about it.
    portal.lookups[2]!.resolve({ found: false });
    const late = await b;
    expect(late.status).toBe("in_progress");
    expect(late.withdrawn).toBeUndefined();
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("unknown");

    const fresh = gateway.approveAndExecute(approval.id, "person-maria");
    await tick();
    portal.lookups[4]!.resolve({ found: false });
    expect(await fresh).toMatchObject({ status: "blocked", withdrawn: true });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("failed");
    expect(portal.posts).toHaveLength(2);
  });

  it("recovery's late absent after a retry filed answers the receipt, never failed", async () => {
    const { portal, store, gateway, approval } = await unknownWithScriptedPortal();
    await gateway.withdrawApproval(approval.id, "person-maria");
    const recovery = gateway.recoverAttempt(approval.idempotencyKey, new Date(), new Date(Date.now() + 60_000).toISOString());
    await tick();
    // While recovery waits on its lookup, the receipt lands (a filing that was already in flight).
    store.putReceipt({
      id: "r1", idempotencyKey: approval.idempotencyKey, actionType: "submit", recipient: "sandbox-agency-portal",
      status: "completed", externalId: "RECEIVED-1", simulated: true, requestHash: "", createdAt: new Date().toISOString(),
    });
    store.updateAttempt(approval.idempotencyKey, "done");
    portal.lookups.at(-1)!.resolve({ found: false });
    expect(await recovery).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    expect(store.getAttempt(approval.idempotencyKey)?.status).toBe("done");
  });
});
