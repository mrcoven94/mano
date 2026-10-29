import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import { evaluatePolicy } from "../src/gateway/policy.js";
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

describe("blocker 2: unknown action types are blocked", () => {
  it('blocks type "toString" instead of executing it', async () => {
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(new MemoryApprovalStore(), exec);
    const result = await gw.requestAction({ ...baseReq(), type: "toString" });
    expect(result.status).toBe("blocked");
    expect(exec.calls.length).toBe(0);
  });

  it('blocks type "__proto__" instead of executing it', async () => {
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(new MemoryApprovalStore(), exec);
    const result = await gw.requestAction({ ...baseReq(), type: "__proto__" });
    expect(result.status).toBe("blocked");
    expect(exec.calls.length).toBe(0);
  });

  it("blocks non-object and malformed requests instead of throwing", async () => {
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor());
    for (const raw of [null, "submit", 42, [], { type: 5 }, { type: "submit" }]) {
      const result = await gw.requestAction(raw);
      expect(result.status).toBe("blocked");
      expect(result.reason).toMatch(/invalid action request/i);
    }
  });

  it("ignores policy overrides for unknown types", () => {
    expect(evaluatePolicy(baseReq())).toBe("ask");
    expect(evaluatePolicy({ ...baseReq(), type: "toString" } as never)).toBe("block");
    expect(
      evaluatePolicy({ ...baseReq(), type: "toString" } as never, { toString: "allow" } as never),
    ).toBe("block");
  });
});
