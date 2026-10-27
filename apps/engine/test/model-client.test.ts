import { describe, expect, it } from "vitest";
import { MetaModelClient, buildModelBaseUrl } from "../src/model-client.js";

describe("model client", () => {
  it("refuses contributor IDs for non-synthetic data", () => {
    const client = new MetaModelClient({ apiKey: "test-key-not-real" });
    expect(() => client.resolveModel(false, "muse-spark-1.3-contributor")).toThrow();
    expect(client.resolveModel(true)).toContain("contributor");
    expect(client.resolveModel(false)).not.toContain("contributor");
  });

  it("builds the AI Gateway URL from config and falls back to direct", () => {
    expect(buildModelBaseUrl({ accountId: "acc", gatewayId: "gw" })).toEqual({
      url: "https://gateway.ai.cloudflare.com/v1/acc/gw/meta",
      via: "ai-gateway",
    });
    expect(buildModelBaseUrl({ accountId: "acc", gatewayId: "gw", provider: "custom" }).url).toContain("/custom");
    expect(buildModelBaseUrl({})).toEqual({ url: "https://api.meta.ai/v1", via: "direct" });
    expect(buildModelBaseUrl({ accountId: "acc" }).via).toBe("direct");
    const client = new MetaModelClient({ apiKey: "k", accountId: "acc", gatewayId: "gw" });
    expect(client.via).toBe("ai-gateway");
    expect(new MetaModelClient({ apiKey: "k" }).via).toBe("direct");
  });

  it("sends store:false with the resolved model and logs cost", async () => {
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const client = new MetaModelClient({
      apiKey: "test-key-not-real",
      fetchFn: (async (url: string, init: RequestInit) => {
        seenBody = JSON.parse(init.body as string) as Record<string, unknown>;
        seenAuth = (init.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ output_text: "hello" }), { status: 200 });
      }) as typeof fetch,
    });
    const out = await client.complete({ input: "hi", synthetic: true });
    expect(out).toEqual({ text: "hello", model: "muse-spark-1.3-contributor" });
    expect(seenBody).toEqual({ model: "muse-spark-1.3-contributor", input: "hi", store: false });
    expect(seenAuth).toBe("Bearer test-key-not-real");
    expect(client.costLog).toHaveLength(1);
    expect(client.costLog[0].synthetic).toBe(true);
  });

  it("retries 429 and 5xx but fails fast on other 4xx", async () => {
    const calls: number[] = [];
    const flaky = new MetaModelClient({
      apiKey: "k",
      maxRetries: 2,
      fetchFn: (async () => {
        const attempt = calls.length;
        calls.push(attempt);
        if (attempt === 0) return new Response("{}", { status: 429 });
        if (attempt === 1) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify({ output_text: "ok" }), { status: 200 });
      }) as typeof fetch,
    });
    const out = await flaky.complete({ input: "hi", synthetic: false });
    expect(out.text).toBe("ok");
    expect(calls).toHaveLength(3);

    let badCalls = 0;
    const bad = new MetaModelClient({
      apiKey: "k",
      fetchFn: (async () => {
        badCalls++;
        return new Response("{}", { status: 400 });
      }) as typeof fetch,
    });
    await expect(bad.complete({ input: "hi", synthetic: false })).rejects.toThrow(/400/);
    expect(badCalls).toBe(1);
  });

  it("retries network errors and timeouts without leaking the key", async () => {
    let calls = 0;
    const client = new MetaModelClient({
      apiKey: "super-secret-key",
      maxRetries: 1,
      timeoutMs: 30,
      fetchFn: (async () => {
        calls++;
        throw new TypeError("network down");
      }) as typeof fetch,
    });
    const err = await client.complete({ input: "hi", synthetic: false }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toBe(2);
    expect(String(err)).not.toContain("super-secret-key");

    const hanging = new MetaModelClient({
      apiKey: "super-secret-key",
      maxRetries: 0,
      timeoutMs: 20,
      fetchFn: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        })) as typeof fetch,
    });
    const timedOut = await hanging.complete({ input: "hi", synthetic: false }).catch((e: Error) => e);
    expect(timedOut.name).toBe("AbortError");
  });
});
