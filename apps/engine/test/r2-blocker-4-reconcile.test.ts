import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  MemoryApprovalStore,
  TimeoutError,
} from "../src/gateway/index.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";

// Re-review blocker 4: a failed reconcile lookup is "unavailable", not
// "did not happen". Unavailable keeps the attempt unknown and blocks.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r2b4-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r2 blocker 4: an unreachable reconcile blocks instead of re-executing", () => {
  it("leaves the attempt unknown when check throws", async () => {
    const store = new MemoryApprovalStore();
    const calls: ActionRequest[] = [];
    const down: Executor = {
      simulated: true,
      async execute(req) {
        calls.push(req);
        throw new TimeoutError();
      },
      async check() {
        throw new Error("portal down");
      },
    };
    const gw = new ActionGateway(store, down, { policyOverrides: { submit: "allow" } });
    const req = baseReq({ idempotencyKey: "r2b4-key" });

    const first = await gw.requestAction(req);
    expect(first.status).toBe("blocked");
    expect(store.getAttempt("r2b4-key")?.status).toBe("unknown");

    const retry = await gw.requestAction(req);
    expect(retry.status).toBe("blocked");
    expect(retry.reason).toMatch(/reconcile|try again|unavailable/i);
    expect(calls.length).toBe(1);
    expect(store.getAttempt("r2b4-key")?.status).toBe("unknown");
  });
});
