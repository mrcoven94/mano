import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActionGateway, DefiniteFailureError, MemoryApprovalStore, TimeoutError } from "../src/gateway/index.js";
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

// LAP-747 follow-up. A proposal the person corrected is never executed
// again: a replayed YES, a YES that waited on the safety check, and
// recovery all refuse it once a newer proposal replaced it. A filing that
// went through still answers its receipt first.
class Office implements Executor {
  readonly simulated = true;
  posts: ActionRequest[] = [];
  filed = new Map<string, string>();
  // What the next post does: refuse it, time out without filing, or file it.
  next: "refuse" | "timeout" | "file" = "refuse";
  async execute(req: ActionRequest) {
    this.posts.push(req);
    const mode = this.next;
    this.next = "file";
    if (mode === "refuse") throw new DefiniteFailureError("The office refused it.");
    if (mode === "timeout") throw new TimeoutError();
    this.filed.set(req.idempotencyKey, `WA-${this.posts.length}`);
    return { externalId: `WA-${this.posts.length}` };
  }
  async check(key: string): Promise<CheckOutcome> {
    const id = this.filed.get(key);
    return id ? { found: true, externalId: id } : { found: false };
  }
}

describe("LAP-747: a replaced proposal is never retried", () => {
  async function correctedAfter(first: "refuse" | "timeout", checker?: { check(): Promise<{ verdict: "pass"; problems: string[] }> }) {
    const office = new Office();
    office.next = first;
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office, checker ? { checker } : {});
    const order = (turnId: string, ms: number) => ({ proposal: { receivedAt: new Date(ms).toISOString(), turnId } });
    const a = await gateway.requestAction(proposal(), new Date(), order("turn-a", Date.now() - 60_000));
    expect((await gateway.approveAndExecute(a.approval!.id, "person-maria")).status).toBe("blocked");
    const b = await gateway.requestAction({ ...proposal(), payload: { phone: "253-555-0199" } }, new Date(), order("turn-b", Date.now()));
    expect(b.status).toBe("needs_approval");
    return { office, store, gateway, a: a.approval!, b: b.approval! };
  }

  it("a replayed YES on the refused original answers superseded and files nothing", async () => {
    const { office, store, gateway, a } = await correctedAfter("refuse");
    expect(store.getAttempt(a.idempotencyKey)?.status).toBe("failed");
    expect(await gateway.approveAndExecute(a.id, "person-maria")).toMatchObject({ status: "blocked", superseded: true });
    expect(office.posts).toHaveLength(1);
  });

  it("a YES retry that waited on the safety check while the correction was prepared files nothing", async () => {
    let pause: Promise<void> | null = null;
    const checker = { check: async () => { if (pause) await pause; return { verdict: "pass" as const, problems: [] }; } };
    const office = new Office();
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office, { checker });
    const order = (turnId: string, ms: number) => ({ proposal: { receivedAt: new Date(ms).toISOString(), turnId } });
    const a = (await gateway.requestAction(proposal(), new Date(), order("turn-a", Date.now() - 60_000))).approval!;
    await gateway.approveAndExecute(a.id, "person-maria");
    let resume!: () => void;
    pause = new Promise<void>((r) => (resume = r));
    const retry = gateway.approveAndExecute(a.id, "person-maria");
    await new Promise((r) => setTimeout(r, 0));
    pause = null;
    await gateway.requestAction({ ...proposal(), payload: { phone: "253-555-0199" } }, new Date(), order("turn-b", Date.now()));
    resume();
    expect(await retry).toMatchObject({ status: "blocked", superseded: true });
    expect(office.posts).toHaveLength(1);
  });

  it("recovery reconciles the replaced original first: absent ends it, never re-executed", async () => {
    const { office, store, gateway, a } = await correctedAfter("timeout");
    expect(store.getAttempt(a.idempotencyKey)?.status).toBe("unknown");
    const swept = await gateway.recoverAttempt(a.idempotencyKey, new Date(), later());
    expect(swept).toMatchObject({ status: "blocked", superseded: true });
    expect(store.getAttempt(a.idempotencyKey)?.status).toBe("failed");
    expect(office.posts).toHaveLength(1);
  });

  it("recovery of a replaced original that did go through still answers its receipt", async () => {
    const office = new Office();
    office.next = "timeout";
    const { store, gateway, a } = await (async () => {
      const store = new MemoryApprovalStore();
      const gateway = new ActionGateway(store, office);
      const order = (turnId: string, ms: number) => ({ proposal: { receivedAt: new Date(ms).toISOString(), turnId } });
      const a = (await gateway.requestAction(proposal(), new Date(), order("turn-a", Date.now() - 60_000))).approval!;
      await gateway.approveAndExecute(a.id, "person-maria");
      await gateway.requestAction({ ...proposal(), payload: { phone: "253-555-0199" } }, new Date(), order("turn-b", Date.now()));
      return { store, gateway, a };
    })();
    office.filed.set(a.idempotencyKey, "WA-1");
    expect(await gateway.recoverAttempt(a.idempotencyKey, new Date(), later())).toMatchObject({ status: "reconciled", receipt: { externalId: "WA-1" } });
    expect(store.getAttempt(a.idempotencyKey)?.status).toBe("done");
  });
});

// LAP-747 follow-up. A correction retires an approved filing that failed
// or went unanswered, even when it only asks a question and no newer
// proposal exists yet. Retired, it is still reconciled but never run again.
describe("LAP-747: a retired approval is never run again", () => {
  async function failedFiling(first: "refuse" | "timeout") {
    const office = new Office();
    office.next = first;
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office);
    const a = (await gateway.requestAction(proposal())).approval!;
    await gateway.approveAndExecute(a.id, "person-maria");
    return { office, store, gateway, a };
  }

  it("a replayed YES on a retired approval files nothing", async () => {
    const { office, store, gateway, a } = await failedFiling("refuse");
    expect(await gateway.retireApproval(a.id, "person-maria")).toMatchObject({ status: "rejected" });
    expect(store.getApproval(a.id)?.status).toBe("retired");
    expect((await gateway.approveAndExecute(a.id, "person-maria")).status).toBe("blocked");
    expect(office.posts).toHaveLength(1);
  });

  it("a YES retry that waited on the safety check while the approval was retired files nothing", async () => {
    let pause: Promise<void> | null = null;
    const checker = { check: async () => { if (pause) await pause; return { verdict: "pass" as const, problems: [] }; } };
    const office = new Office();
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office, { checker });
    const a = (await gateway.requestAction(proposal())).approval!;
    await gateway.approveAndExecute(a.id, "person-maria");
    let resume!: () => void;
    pause = new Promise<void>((r) => (resume = r));
    const retry = gateway.approveAndExecute(a.id, "person-maria");
    await new Promise((r) => setTimeout(r, 0));
    expect((await gateway.retireApproval(a.id, "person-maria")).status).toBe("rejected");
    resume();
    expect((await retry).status).toBe("blocked");
    expect(office.posts).toHaveLength(1);
  });

  // Review round 10: the correction read A as failed, then a concurrent
  // YES retried it and lost the response, so A is unknown when the retire
  // lands. It must not be retired: the filing may have arrived.
  it("an attempt a concurrent YES left unknown after it was read as failed is not retired", async () => {
    const { office, store, gateway, a } = await failedFiling("refuse");
    expect(store.getAttempt(a.idempotencyKey)?.status).toBe("failed");
    office.next = "timeout";
    expect((await gateway.approveAndExecute(a.id, "person-maria")).status).toBe("blocked");
    expect(store.getAttempt(a.idempotencyKey)?.status).toBe("unknown");
    expect((await gateway.retireApproval(a.id, "person-maria")).status).toBe("in_progress");
    expect(store.getApproval(a.id)?.status).toBe("approved");
  });

  it("retiring answers completed once a receipt exists and in_progress while a filing is in flight, and changes nothing", async () => {
    const filed = await failedFiling("refuse");
    filed.store.putReceipt({
      id: "r1", idempotencyKey: filed.a.idempotencyKey, actionType: "submit", recipient: "sandbox-agency-portal",
      status: "reconciled", externalId: "WA-1", simulated: true, requestHash: "", createdAt: new Date().toISOString(),
    });
    expect(await filed.gateway.retireApproval(filed.a.id, "person-maria")).toMatchObject({ status: "completed" });
    expect(filed.store.getApproval(filed.a.id)?.status).toBe("approved");

    const flying = await failedFiling("refuse");
    flying.store.updateAttempt(flying.a.idempotencyKey, "in_flight");
    expect((await flying.gateway.retireApproval(flying.a.id, "person-maria")).status).toBe("in_progress");
    expect(flying.store.getApproval(flying.a.id)?.status).toBe("approved");
    expect((await flying.gateway.retireApproval(flying.a.id, "person-someone-else")).status).toBe("blocked");
  });
});

// Two retries of an unanswered filing: retry 2 files it and stores
// RECEIVED-1, then a correction is prepared, then retry 1's late absent
// lookup returns. The receipt wins over superseded.
describe("LAP-747: a receipt is answered before superseded", () => {
  it("retry 1's late absent after retry 2 filed and a correction was prepared answers RECEIVED-1", async () => {
    const portal = new ScriptedPortal();
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, portal);
    const order = (turnId: string, ms: number) => ({ proposal: { receivedAt: new Date(ms).toISOString(), turnId } });
    const a = (await gateway.requestAction(proposal(), new Date(), order("turn-a", Date.now() - 60_000))).approval!;
    const first = gateway.approveAndExecute(a.id, "person-maria");
    await tick();
    portal.filings[0]!.reject(new TimeoutError());
    await tick();
    portal.lookups[0]!.reject(new Error("portal unreachable"));
    await first;

    const retry1 = gateway.approveAndExecute(a.id, "person-maria");
    const retry2 = gateway.approveAndExecute(a.id, "person-maria");
    await tick();
    portal.lookups[2]!.resolve({ found: false });
    await tick();
    portal.filings[1]!.resolve({ externalId: "RECEIVED-1" });
    expect(await retry2).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    await gateway.requestAction({ ...proposal(), payload: { phone: "253-555-0199" } }, new Date(), order("turn-b", Date.now()));
    portal.lookups[1]!.resolve({ found: false });
    expect(await retry1).toMatchObject({ status: "completed", receipt: { externalId: "RECEIVED-1" } });
    expect(portal.posts).toHaveLength(2);
  });
});

// LAP-747 follow-up: a receipt under the key is answered before any
// refusal (superseded, retired, declined, already used).
describe("LAP-747: a receipt wins on every answer", () => {
  it("YES 1 paused in the safety check, YES 2 files RECEIVED-1, a correction is prepared, then YES 1 resumes: RECEIVED-1", async () => {
    let pause: Promise<void> | null = null;
    const checker = { check: async () => { if (pause) await pause; return { verdict: "pass" as const, problems: [] }; } };
    const office = new Office();
    office.next = "file";
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office, { checker });
    const order = (turnId: string, ms: number) => ({ proposal: { receivedAt: new Date(ms).toISOString(), turnId } });
    const a = (await gateway.requestAction(proposal(), new Date(), order("turn-a", Date.now() - 60_000))).approval!;
    let resume!: () => void;
    pause = new Promise<void>((r) => (resume = r));
    const yes1 = gateway.approveAndExecute(a.id, "person-maria");
    await new Promise((r) => setTimeout(r, 0));
    pause = null;
    const yes2 = await gateway.approveAndExecute(a.id, "person-maria");
    expect(yes2).toMatchObject({ status: "completed", receipt: { externalId: "WA-1" } });
    await gateway.requestAction({ ...proposal(), payload: { phone: "253-555-0199" } }, new Date(), order("turn-b", Date.now()));
    resume();
    expect(await yes1).toMatchObject({ status: "completed", receipt: { externalId: "WA-1" } });
    expect(office.posts).toHaveLength(1);
  });

  it("a retired filing whose receipt is later recorded answers RECEIVED-1 to a repeated retire and to a replayed YES", async () => {
    const office = new Office();
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office);
    const a = (await gateway.requestAction(proposal())).approval!;
    await gateway.approveAndExecute(a.id, "person-maria");
    expect((await gateway.retireApproval(a.id, "person-maria")).status).toBe("rejected");
    store.putReceipt({
      id: "r1", idempotencyKey: a.idempotencyKey, actionType: "submit", recipient: "sandbox-agency-portal",
      status: "reconciled", externalId: "RECEIVED-1", simulated: true, requestHash: "", createdAt: new Date().toISOString(),
    });
    expect(await gateway.retireApproval(a.id, "person-maria")).toMatchObject({ status: "completed", replayed: true, receipt: { externalId: "RECEIVED-1" } });
    expect(await gateway.approveAndExecute(a.id, "person-maria")).toMatchObject({ status: "completed", replayed: true, receipt: { externalId: "RECEIVED-1" } });
    expect((await gateway.approveAndExecute(a.id, "person-someone-else")).status).toBe("blocked");
    expect(office.posts).toHaveLength(1);
  });
});

describe("LAP-747: Engine's SQL store retires only a failed attempt at the version read", () => {
  it("retires a failed attempt at its version, and nothing else", async () => {
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName("lap747-retire-sql"));
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      ensureGatewayTables(sql);
      const store = new SqlApprovalStore(sql);
      const base = {
        actionType: "submit", recipient: "sandbox-agency-portal", purpose: "renewal", documentHash: null, documentId: null,
        approvedByHumanId: "person-maria", personId: "person-maria", requestJson: "{}", requestHash: "h", problems: [],
        createdAt: new Date().toISOString(), remindAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), escalated: false,
      } as const;
      const attempt = { updatedAt: "2026-11-03T00:00:00.000Z", requestHash: "h", actionType: "submit", recipient: "r", personId: "person-maria" } as const;
      store.putApproval({ ...base, id: "a-failed", idempotencyKey: "kf", status: "approved" } as never);
      store.insertAttempt({ ...attempt, key: "kf", status: "failed" });
      const read = store.getAttempt("kf")!.version!;
      store.putApproval({ ...base, id: "a-unknown", idempotencyKey: "ku", status: "approved" } as never);
      store.insertAttempt({ ...attempt, key: "ku", status: "unknown" });

      expect(store.retireApproval("a-unknown", store.getAttempt("ku")!.version!)).toBe(false);
      expect(store.retireApproval("a-failed", read + 1)).toBe(false);
      expect(store.retireApproval("a-failed", read)).toBe(true);
      expect(store.getApproval("a-failed")?.status).toBe("retired");
      expect(store.getApproval("a-unknown")?.status).toBe("approved");
    });
  });
});

describe("LAP-747: a NO on a filed approval answers its receipt", () => {
  it("rejecting a completed approval rejects nothing and answers the receipt, for its own person only", async () => {
    const office = new Office();
    office.next = "file";
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office);
    const a = (await gateway.requestAction(proposal())).approval!;
    const filed = await gateway.approveAndExecute(a.id, "person-maria");
    expect(filed.status).toBe("completed");
    expect(await gateway.rejectApproval(a.id, "person-maria")).toMatchObject({ status: "completed", receipt: { externalId: filed.receipt!.externalId } });
    expect(store.getApproval(a.id)?.status).toBe("approved");
    expect((await gateway.rejectApproval(a.id, "person-someone-else")).status).toBe("blocked");
  });
});

// LAP-747 follow-up: the receipt, the attempt's done mark and the action's
// own effect are one transaction, so a crash cannot leave a receipt whose
// effect never ran.
describe("LAP-747: a receipt and its effect commit together", () => {
  it("when the effect fails, the receipt is rolled back with it, and nothing claims the filing done", async () => {
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName("lap747-atomic"));
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      ensureGatewayTables(sql);
      const store = new SqlApprovalStore(sql, (fn) => state.storage.transactionSync(fn));
      const office = new Office();
      office.next = "file";
      let effects = 0;
      const crashing = new ActionGateway(store, office, { onReceipt: () => { throw new Error("process lost mid-effect"); } });
      const a = (await crashing.requestAction(proposal())).approval!;
      expect((await crashing.approveAndExecute(a.id, "person-maria")).status).toBe("blocked");
      expect(store.getReceiptByKey(a.idempotencyKey)).toBeNull();
      expect(store.getAttempt(a.idempotencyKey)?.status).toBe("unknown");

      // The next lookup finds the filing and records it with its effect, once.
      const steady = new ActionGateway(store, office, { onReceipt: () => { effects += 1; } });
      expect((await steady.approveAndExecute(a.id, "person-maria")).status).toBe("reconciled");
      expect(store.getReceiptByKey(a.idempotencyKey)).not.toBeNull();
      expect(effects).toBe(1);
    });
  });
});

// LAP-747 follow-up: a correction fences the form against older turns.
describe("LAP-747: drafts from turns older than a correction are refused", () => {
  const order = (turnId: string, ms: number) => ({ receivedAt: new Date(ms).toISOString(), turnId });
  const now = Date.now();

  it("closes waiting older drafts, refuses new ones from older turns, and keeps the correcting turn's own", async () => {
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, new Office());
    const a = (await gateway.requestAction(proposal(), new Date(), { proposal: order("turn-a", now - 2000) })).approval!;
    expect(await gateway.fenceProposals("sandbox-agency-portal", order("turn-b", now - 1000), 0)).toEqual({ closed: 1 });
    expect(store.getApproval(a.id)?.status).toBe("rejected");
    expect(await gateway.requestAction(proposal(), new Date(), { proposal: order("turn-a", now - 2000) })).toMatchObject({ status: "blocked", superseded: true });
    expect((await gateway.requestAction(proposal(), new Date(), { proposal: order("turn-b", now - 1000) })).status).toBe("needs_approval");
    // An older fence never moves it back, and another form is untouched.
    await gateway.fenceProposals("sandbox-agency-portal", order("turn-0", now - 5000), 0);
    expect(store.proposalFenced("sandbox-agency-portal", order("turn-a", now - 2000))).toBe(true);
    expect(store.proposalFenced("another-office", order("turn-a", now - 2000))).toBe(false);
    expect(await gateway.fenceProposals("sandbox-agency-portal", order("turn-c", now), 7)).toBeNull();
  });

  it("an older turn's draft that was waiting on the safety check when the fence landed is refused at the insert", async () => {
    let pause: Promise<void> | null = null;
    const checker = { check: async () => { if (pause) await pause; return { verdict: "pass" as const, problems: [] }; } };
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, new Office(), { checker });
    let resume!: () => void;
    pause = new Promise<void>((r) => (resume = r));
    const late = gateway.requestAction(proposal(), new Date(), { proposal: order("turn-a", now - 2000) });
    await new Promise((r) => setTimeout(r, 0));
    pause = null;
    await gateway.fenceProposals("sandbox-agency-portal", order("turn-b", now - 1000), 0);
    resume();
    expect(await late).toMatchObject({ status: "blocked", superseded: true });
    expect(store.approvals.size).toBe(0);
  });

  it("Engine's SQL store fences by turn order within the current generation", async () => {
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName("lap747-fence-sql"));
    await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      ensureGatewayTables(sql);
      const store = new SqlApprovalStore(sql);
      const gateway = new ActionGateway(store, new Office());
      const a = (await gateway.requestAction(proposal(), new Date(), { proposal: order("turn-a", now - 2000) })).approval!;
      const b = (await gateway.requestAction(proposal(), new Date(), { proposal: order("turn-b", now - 1000) })).approval!;
      expect(store.fenceProposals("sandbox-agency-portal", order("turn-b", now - 1000), store.generation())).toBe(1);
      expect(store.getApproval(a.id)?.status).toBe("rejected");
      expect(store.getApproval(b.id)?.status).toBe("pending");
      expect(store.proposalFenced("sandbox-agency-portal", order("turn-a", now - 2000))).toBe(true);
      expect(store.proposalFenced("sandbox-agency-portal", order("turn-b", now - 1000))).toBe(false);
      store.fenceProposals("sandbox-agency-portal", order("turn-0", now - 9000), store.generation());
      expect(store.proposalFenced("sandbox-agency-portal", order("turn-a", now - 2000))).toBe(true);
    });
  });
});

describe("LAP-747: a replayed filing answers its receipt before the fence", () => {
  it("replaying completed action K from turn A after turn B fenced the form answers K's receipt", async () => {
    const order = (turnId: string, ms: number) => ({ receivedAt: new Date(ms).toISOString(), turnId });
    const now = Date.now();
    const office = new Office();
    office.next = "file";
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, office);
    const k = proposal();
    const held = await gateway.requestAction(k, new Date(), { proposal: order("turn-a", now - 2000) });
    const filed = await gateway.approveAndExecute(held.approval!.id, "person-maria");
    expect(filed.status).toBe("completed");
    await gateway.fenceProposals("sandbox-agency-portal", order("turn-b", now - 1000), 0);
    expect(await gateway.requestAction(k, new Date(), { proposal: order("turn-a", now - 2000) })).toMatchObject({ status: "completed", receipt: { externalId: filed.receipt!.externalId } });
    expect(office.posts).toHaveLength(1);
  });
});
