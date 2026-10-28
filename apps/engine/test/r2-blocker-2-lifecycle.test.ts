import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Re-review blocker 2: lifecycle writes must never come from a snapshot the
// gateway read before an await. A checker running mid-approve cannot revive
// an expired or consumed approval.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r2b2-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r2 blocker 2: no stale write can revive an approval", () => {
  it("keeps an approval expired when a fix verdict lands after the alarm", async () => {
    const store = new MemoryApprovalStore();
    const exec = new InMemoryExecutor();
    let targetId = "";
    const gw = new ActionGateway(store, exec, {
      // Simulates the expiry alarm firing while the checker runs.
      checker: {
        async check() {
          const current = store.getApproval(targetId);
          if (current) store.putApproval({ ...current, status: "expired" });
          return { verdict: "fix", problems: ["needs a human look"] };
        },
      },
    });
    const first = await gw.requestAction(baseReq());
    expect(first.status).toBe("needs_approval");
    targetId = first.approval!.id;

    const result = await gw.approveAndExecute(targetId, "maria");
    expect(result.status).toBe("blocked");
    expect(store.getApproval(targetId)?.status).toBe("expired");
    expect(exec.calls.length).toBe(0);
  });

  it("executes once when a concurrent approve wins while the checker runs", async () => {
    const store = new MemoryApprovalStore();
    const exec = new InMemoryExecutor();
    let targetId = "";
    const gw = new ActionGateway(store, exec, {
      // Simulates a concurrent approve that consumes and executes first.
      checker: {
        async check() {
          const current = store.getApproval(targetId);
          if (current) {
            const consumed = store.consumeApprovalAndClaim(
              targetId,
              "maria",
              {
                key: current.idempotencyKey,
                status: "in_flight",
                updatedAt: new Date().toISOString(),
                requestHash: "",
                actionType: current.actionType,
                recipient: current.recipient,
                personId: current.personId,
              },
              { personId: current.personId, requestHash: current.requestHash, now: new Date() },
            );
            if (consumed) await exec.execute(JSON.parse(consumed.requestJson) as ActionRequest);
          }
          return { verdict: "fix", problems: ["needs a human look"] };
        },
      },
    });
    const first = await gw.requestAction(baseReq());
    expect(first.status).toBe("needs_approval");
    targetId = first.approval!.id;

    const result = await gw.approveAndExecute(targetId, "maria");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/already used/i);
    expect(store.getApproval(targetId)?.status).toBe("approved");
    expect(exec.calls.length).toBe(1);
  });
});
