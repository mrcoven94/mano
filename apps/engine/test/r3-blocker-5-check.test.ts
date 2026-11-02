import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  MemoryApprovalStore,
  SandboxExecutor,
  TimeoutError,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 3, blocker 5 through the real SandboxExecutor parser: only the
// contract's explicit absent response (404) means absent. A 200 without
// an external ID is malformed, so the lookup is unavailable.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r3b5-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r3 blocker 5: malformed lookups are unavailable, never absent", () => {
  it("treats HTTP 200 without an external ID as unavailable", async () => {
    const fetchFn = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn);
    await expect(exec.check("any-key", "maria")).rejects.toThrow(/malformed|unavailable/i);
  });

  it("keeps the attempt unknown instead of executing after a malformed lookup", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/submissions")) throw new TimeoutError();
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const store = new MemoryApprovalStore();
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn);
    const gw = new ActionGateway(store, exec, { policyOverrides: { submit: "allow" } });
    const key = "r3b5-malformed";

    const first = await gw.requestAction(baseReq({ idempotencyKey: key }));
    expect(first.status).toBe("blocked");
    expect(store.getAttempt(key)?.status).toBe("unknown");

    const retry = await gw.requestAction(baseReq({ idempotencyKey: key }));
    expect(retry.status).toBe("blocked");
    expect(retry.reason).toMatch(/reconcile|cannot reach|try again/i);
    expect(store.getAttempt(key)?.status).toBe("unknown");
    expect(seen.filter((u) => u.endsWith("/submissions")).length).toBe(1);
  });
});
