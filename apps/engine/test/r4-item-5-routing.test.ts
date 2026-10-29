import { env as testEnv } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
  TimeoutError,
  setExecutorFactoryForTests,
  type ActionRequest,
  type CheckOutcome,
  type Executor,
} from "../src/gateway/index.js";
import { ConsentDeliveringExecutor } from "../src/agents/person-executor.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

afterEach(() => {
  setExecutorFactoryForTests(null);
});

// Round 4, item 5: reconcile routing follows the persisted attempt's
// action type, never a caller-controlled key prefix. A submit keyed
// like a consent grant must ask the outside system; a share with a
// plain key must ask the org.

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function baseSubmit(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r4i5-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "r4i5",
    sources: [],
    origin: "person",
    ...over,
  };
}

// Records the outcome, then reports the timeout: the retry must
// reconcile through the inner executor, not the org.
function timeoutInner(calls: ActionRequest[]) {
  const recorded = new Map<string, string>();
  const inner: Executor = {
    simulated: true,
    async execute(req) {
      calls.push(req);
      recorded.set(req.idempotencyKey, "ext-1");
      throw new TimeoutError();
    },
    async check(key) {
      const hit = recorded.get(key);
      return hit ? { found: true as const, externalId: hit } : { found: false as const };
    },
  };
  return inner;
}

describe("r4 item 5: reconcile routing follows the attempt", () => {
  it("reconciles a consent-prefixed submit against the inner executor", async () => {
    const store = new MemoryApprovalStore();
    const calls: ActionRequest[] = [];
    let shareChecks = 0;
    const exec = new ConsentDeliveringExecutor(
      timeoutInner(calls),
      async () => {
        throw new Error("A submit must never deliver as a share.");
      },
      async (): Promise<CheckOutcome> => {
        shareChecks += 1;
        return { found: false };
      },
      (key) => store.getAttempt(key)?.actionType ?? null,
    );
    const gw = new ActionGateway(store, exec);

    const first = await gw.requestAction(baseSubmit({ idempotencyKey: "consent-grant:r4i5:case-1" }));
    expect(first.status).toBe("needs_approval");
    const done = await gw.approveAndExecute(first.approval!.id, "r4i5");
    expect(done.status).toBe("reconciled");
    expect(done.receipt?.externalId).toBe("ext-1");
    expect(shareChecks).toBe(0);
    expect(calls.length).toBe(1);
  });

  it("reconciles a plain-keyed share against the org", async () => {
    const store = new MemoryApprovalStore();
    const innerCalls: ActionRequest[] = [];
    const inner: Executor = {
      simulated: true,
      async execute(req) {
        innerCalls.push(req);
        return { externalId: "inner-ext" };
      },
      async check() {
        return { found: false as const };
      },
    };
    let deliveries = 0;
    let shareChecks = 0;
    const exec = new ConsentDeliveringExecutor(
      inner,
      async () => {
        deliveries += 1;
        if (deliveries === 1) throw new TimeoutError();
        return { externalId: "msg-1" };
      },
      async (): Promise<CheckOutcome> => {
        shareChecks += 1;
        return { found: true, externalId: "msg-1" };
      },
      (key) => store.getAttempt(key)?.actionType ?? null,
    );
    const gw = new ActionGateway(store, exec, {
      listConsents: () => [{ recipient: "org:r4i5-county", purpose: "renewal" }],
    });

    const first = await gw.requestAction({
      ...baseSubmit({
        type: "share",
        recipient: "org:r4i5-county",
        payload: { consent: "grant", caseId: "case-r4i5-plain", scope: ["documents"] },
        idempotencyKey: "r4i5-plain-1",
      }),
    });
    expect(first.status).toBe("needs_approval");
    const done = await gw.approveAndExecute(first.approval!.id, "r4i5");
    expect(done.status).toBe("reconciled");
    expect(shareChecks).toBe(1);
    expect(deliveries).toBe(1);
    expect(innerCalls.length).toBe(0);
  });

  it("reconciles a consent-prefixed submit through a real agent without re-posting", async () => {
    const shared = new InMemoryExecutor();
    shared.failNextWithTimeout = true;
    setExecutorFactoryForTests(() => shared);
    const person = personStub("r4i5-agent");

    const first = await person.requestAction(
      baseSubmit({ personId: "r4i5-agent", idempotencyKey: "consent-grant:r4i5agent:case-1" }),
      "r4i5-agent",
    );
    expect(first.status).toBe("needs_approval");
    const done = await person.approve(first.approval!.id, "r4i5-agent");
    expect(done.status, done.reason).toBe("reconciled");
    expect(shared.calls.length).toBe(1);
  });
});
