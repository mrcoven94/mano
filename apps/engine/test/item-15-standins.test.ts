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
    expect(createExecutor({}).simulated).toBe(true);
    expect(createExecutor({ EXECUTOR_MODE: "simulated" })).toBeInstanceOf(InMemoryExecutor);
    expect(() => createExecutor({ EXECUTOR_MODE: "sandbox" })).toThrow(/SANDBOX_BASE_URL/);
    const sandbox = createExecutor({ EXECUTOR_MODE: "sandbox", SANDBOX_BASE_URL: "https://portal.test/" });
    expect(sandbox.simulated).toBe(false);
    expect(() => createExecutor({ EXECUTOR_MODE: "nope" })).toThrow(/Unknown EXECUTOR_MODE/);
  });

  it("drives the sandbox portal contract", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      if (url.endsWith("/v1/actions")) return new Response(JSON.stringify({ externalId: "portal-1" }), { status: 200 });
      if (url.includes("known-key")) return new Response(JSON.stringify({ externalId: "portal-1" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn);
    const out = await exec.execute(baseReq({ idempotencyKey: "k-1" }));
    expect(out).toEqual({ externalId: "portal-1" });
    const posted = JSON.parse(seen[0].init.body as string) as Record<string, unknown>;
    expect(posted.idempotencyKey).toBe("k-1");
    expect(posted.type).toBe("submit");
    expect(await exec.check("known-key")).toEqual({ externalId: "portal-1" });
    expect(await exec.check("missing-key")).toBeNull();
  });

  it("proceeds when a check fails instead of throwing", async () => {
    const exec: Executor = {
      simulated: true,
      async execute() {
        return { externalId: "ext-1" };
      },
      async check() {
        throw new Error("portal down");
      },
    };
    const gw = new ActionGateway(new MemoryApprovalStore(), exec, {
      policyOverrides: { submit: "allow" },
    });
    const result = await gw.requestAction(baseReq());
    expect(result.status).toBe("completed");
  });

  it("uses the stand-in model client without a key", async () => {
    const standin = createModelClient({});
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
    expect(body.live.sessionSecret).toBe("set");
    expect(JSON.stringify(body)).not.toContain("test-key-not-real");
  });
});
