import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  MemoryApprovalStore,
  TimeoutError,
} from "../src/gateway/index.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";

// Round 5, item 2 through the real gateway: recovery re-verifies
// approval liveness in the same step that claims the key, so a window
// that lapses during the awaited checks cannot execute. Expiry needs
// time travel, which agent RPCs cannot do; the window is lapsed by
// backdating the row, mirroring the round 3 clock tests.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r5i2-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r5 item 2: recovery never executes past expiry", () => {
  it("does not execute when the window lapses during recovery checks", async () => {
    const store = new MemoryApprovalStore();
    const calls: ActionRequest[] = [];
    const exec: Executor = {
      simulated: true,
      async execute(req) {
        calls.push(req);
        throw new TimeoutError();
      },
      async check() {
        return { found: false as const };
      },
    };
    const gw = new ActionGateway(store, exec, {
      checker: {
        async check() {
          await new Promise((r) => setTimeout(r, 150));
          return { verdict: "pass", problems: [] };
        },
      },
    });
    const key = "r5i2-lapse";
    const pending = await gw.requestAction(baseReq({ idempotencyKey: key }));
    expect(pending.status).toBe("needs_approval");
    const first = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(calls.length).toBe(1);

    // The window ends 50ms from now; recovery's checker still runs past it.
    const approval = store.getApproval(pending.approval!.id)!;
    store.putApproval({ ...approval, expiresAt: new Date(Date.now() + 50).toISOString() });

    const recovered = await gw.recoverAttempt(key, new Date(), new Date(Date.now() + 3600_000).toISOString());
    expect(recovered?.status).toBe("blocked");
    expect(recovered?.reason).toMatch(/expired/i);
    expect(calls.length).toBe(1);
    expect(store.getAttempt(key)?.status).toBe("failed");
  });
});
