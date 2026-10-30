import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
  SandboxExecutor,
  createExecutor,
} from "../src/gateway/index.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";
import { MetaModelClient, StandInModelClient, createModelClient } from "../src/model-client.js";

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

describe("item 15: swappable executors and stand-ins", () => {
  it("picks the executor from config and fails loud on bad config", () => {
    expect(() => createExecutor({})).toThrow(/EXECUTOR_MODE/);
    expect(createExecutor({ MANO_ENV: "development" }).simulated).toBe(true);
    expect(createExecutor({ EXECUTOR_MODE: "simulated" })).toBeInstanceOf(InMemoryExecutor);
    expect(() => createExecutor({ EXECUTOR_MODE: "sandbox" })).toThrow(/SANDBOX_BASE_URL/);
    expect(() => createExecutor({ EXECUTOR_MODE: "sandbox", SANDBOX_BASE_URL: "https://portal.test/" })).toThrow(/SANDBOX_PORTAL_TOKEN/);
    const sandbox = createExecutor({ EXECUTOR_MODE: "sandbox", SANDBOX_BASE_URL: "https://portal.test/", SANDBOX_PORTAL_TOKEN: "t" });
    expect(sandbox.simulated).toBe(false);
    expect(() => createExecutor({ EXECUTOR_MODE: "nope" })).toThrow(/Unknown EXECUTOR_MODE/);
  });

  it("blocks when a reconcile check fails instead of executing", async () => {
    const store = new MemoryApprovalStore();
    let calls = 0;
    const exec: Executor = {
      simulated: true,
      async execute() {
        calls += 1;
        return { externalId: "ext-1" };
      },
      async check() {
        throw new Error("portal down");
      },
    };
    const gw = new ActionGateway(store, exec, {
      policyOverrides: { submit: "allow" },
    });
    const first = await gw.requestAction(baseReq({ idempotencyKey: "i15-down" }));
    expect(first.status).toBe("completed");
    expect(calls).toBe(1);
    // An unknown attempt with a failed check blocks; the failed check
    // never triggers a second execution.
    store.receipts.delete("i15-down");
    store.updateAttempt("i15-down", "unknown");
    const retry = await gw.requestAction(baseReq({ idempotencyKey: "i15-down" }));
    expect(retry.status).toBe("blocked");
    expect(calls).toBe(1);
  });

  it("uses the stand-in model client without a key in development only", async () => {
    expect(() => createModelClient({})).toThrow(/META_MODEL_API_KEY/);
    const standin = createModelClient({ MANO_ENV: "development" });
    expect(standin).toBeInstanceOf(StandInModelClient);
    const out = await standin.complete({ input: "hello", synthetic: true });
    expect(out.model).toBe("stand-in");
    expect(out.text).toMatch(/stand-in/);
    const live = createModelClient({ META_MODEL_API_KEY: "k" });
    expect(live).toBeInstanceOf(MetaModelClient);
  });

  it("reports which parts are live without values", async () => {
    const res = await SELF.fetch("https://mano.test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; live: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.live.model).toBe("meta");
    expect(body.live.modelVia).toBe("direct");
    expect(body.live.executor).toBe("simulated");
    expect(body.live.files).toBe("bound");
    expect(body.live.kek).toBe(true);
    expect("sessionSecret" in body.live).toBe(false);
    expect(JSON.stringify(body)).not.toContain("test-key-not-real");
  });
});
