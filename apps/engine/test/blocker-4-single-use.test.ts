import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

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

describe("blocker 4: one approval authorizes one action", () => {
  it("refuses a second approval of the same approval", async () => {
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(new MemoryApprovalStore(), exec);
    const first = await gw.requestAction(baseReq({ personId: "b4maria" }));
    const ok = await gw.approveAndExecute(first.approval!.id, "b4maria");
    expect(ok.status).toBe("completed");
    const again = await gw.approveAndExecute(first.approval!.id, "b4maria");
    expect(again.status).toBe("blocked");
    expect(again.reason).toMatch(/already used/i);
    expect(exec.calls.length).toBe(1);
  });

  it("refuses approval by a different person", async () => {
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor());
    const first = await gw.requestAction(baseReq({ personId: "b4maria" }));
    const result = await gw.approveAndExecute(first.approval!.id, "eve");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/different person/i);
  });

  it("refuses an expired approval", async () => {
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor());
    const first = await gw.requestAction(baseReq({ personId: "b4maria" }));
    const late = new Date(Date.now() + 25 * 3600_000);
    const result = await gw.approveAndExecute(first.approval!.id, "b4maria", late);
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/expired/i);
  });
});
