import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 3, blocker 3: the consuming claim reads the clock itself. An
// approval that expires while the gateway's async work runs must not
// execute.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r3b3-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r3 blocker 3: approvals expiring mid-approve do not execute", () => {
  it("blocks when the window lapses during the checker run", async () => {
    const store = new MemoryApprovalStore();
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(store, exec, {
      checker: {
        async check() {
          await new Promise((r) => setTimeout(r, 150));
          return { verdict: "pass", problems: [] };
        },
      },
    });
    const first = await gw.requestAction(baseReq());
    expect(first.status).toBe("needs_approval");
    // The window ends 30ms after the approve call starts; the checker
    // above still runs when it does.
    const approval = store.getApproval(first.approval!.id)!;
    store.putApproval({ ...approval, expiresAt: new Date(Date.now() + 30).toISOString() });

    const result = await gw.approveAndExecute(first.approval!.id, "maria");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/expired/i);
    expect(exec.calls.length).toBe(0);
  });
});
