import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
  TimeoutError,
} from "../src/gateway/index.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `key-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("blocker 7: single flight and reconcile before re-execution", () => {
  it("runs two concurrent sends with one key exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = new InMemoryExecutor();
    const slow: Executor & { calls: ActionRequest[] } = {
      simulated: true,
      calls: inner.calls,
      async execute(req) {
        await gate;
        return inner.execute(req);
      },
      check: (k) => inner.check(k),
    };
    const gw = new ActionGateway(new MemoryApprovalStore(), slow, {
      policyOverrides: { submit: "allow" },
    });
    const req = baseReq({ idempotencyKey: "b7-key" });
    const p1 = gw.requestAction(req);
    const p2 = gw.requestAction(req);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["completed", "in_progress"]);
    expect(inner.calls.length).toBe(1);
  });

  it("reconciles an unknown attempt before executing again", async () => {
    const events: string[] = [];
    const flaky: Executor & { calls: ActionRequest[] } = {
      simulated: true,
      calls: [],
      async execute(req) {
        events.push("execute");
        this.calls.push(req);
        throw new TimeoutError();
      },
      async check() {
        events.push("check");
        return null;
      },
    };
    const gw = new ActionGateway(new MemoryApprovalStore(), flaky, {
      policyOverrides: { submit: "allow" },
    });
    const req = baseReq({ idempotencyKey: "b7-unknown" });
    const first = await gw.requestAction(req);
    expect(first.status).toBe("blocked");
    expect(first.reason).toMatch(/unknown/i);
    expect(events).toEqual(["execute", "check"]);
    const second = await gw.requestAction(req);
    expect(second.status).toBe("blocked");
    // The retry reconciles (check) before it executes again, then
    // reconciles the second timeout afterward.
    expect(events).toEqual(["execute", "check", "check", "execute", "check"]);
    expect(flaky.calls.length).toBe(2);
  });
});
