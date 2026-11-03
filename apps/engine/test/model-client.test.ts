import { afterEach, describe, expect, it, vi } from "vitest";
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
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
          }),
          { status: 200 },
        );
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
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          }),
          { status: 200 },
        );
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

  it("extracts text from output items and rejects incomplete runs", async () => {
    const client = new MetaModelClient({
      apiKey: "k",
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "reasoning", summary: [] },
              { type: "message", content: [{ type: "output_text", text: "ready" }] },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    expect((await client.complete({ input: "hi", synthetic: true })).text).toBe("ready");

    const failed = new MetaModelClient({
      apiKey: "k",
      fetchFn: (async () =>
        new Response(JSON.stringify({ status: "failed", error: { message: "boom" }, output: [] }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(failed.complete({ input: "hi", synthetic: true })).rejects.toThrow("Model run failed.");
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
    let timedOut: Error | null = null;
    try {
      await hanging.complete({ input: "hi", synthetic: false });
    } catch (e) {
      timedOut = e as Error;
    }
    expect(timedOut?.message).toBe("Model request timed out.");
  });

  it("settles a retryable status before reading its body", async () => {
    let calls = 0;
    const client = new MetaModelClient({
      apiKey: "k",
      maxRetries: 1,
      fetchFn: (async () => {
        calls++;
        if (calls === 1) return new Response("<html>upstream down</html>", { status: 503 });
        return new Response(
          JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect((await client.complete({ input: "hi", synthetic: false })).text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries a timeout while the body is read", async () => {
    let calls = 0;
    const client = new MetaModelClient({
      apiKey: "k",
      maxRetries: 1,
      timeoutMs: 20,
      fetchFn: (async (_url: string, init: RequestInit) => {
        calls++;
        if (calls > 1) {
          return new Response(
            JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
            { status: 200 },
          );
        }
        const stalled = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              controller.error(err);
            });
          },
        });
        return new Response(stalled, { status: 200 });
      }) as typeof fetch,
    });
    expect((await client.complete({ input: "hi", synthetic: false })).text).toBe("ok");
    expect(calls).toBe(2);
  });

  describe("never repeats the provider's text", () => {
    const LEAK = "Key mk-synthetic-7f3a91 is not valid for Maria Santos on case CA-2026-1.";
    const SECRETS = ["mk-synthetic-7f3a91", "Maria Santos", "CA-2026-1"];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    afterEach(() => {
      for (const spy of logged) spy.mockClear();
    });

    it.each([
      ["a 401", () => json({ error: { message: LEAK, type: "auth_error", code: LEAK } }, 401), "Model request failed: 401 (the API key was not accepted)"],
      ["a 400", () => json({ error: { message: LEAK } }, 400), "Model request failed: 400 (the request was not valid)"],
      ["an unlisted 418", () => json({ error: { message: LEAK } }, 418), "Model request failed: 418"],
      ["a 429", () => new Response(`<html>${LEAK}</html>`, { status: 429 }), "Model request failed: 429 (rate limited)"],
      ["a 503", () => new Response(`<html>${LEAK}</html>`, { status: 503 }), "Model request failed: 503"],
      ["a failed run", () => json({ status: "failed", error: { message: LEAK } }), "Model run failed."],
      ["a run in an unknown state", () => json({ status: LEAK }), "Model run not completed."],
      ["a malformed 200", () => new Response(`<html>${LEAK}</html>`, { status: 200 }), "Model response was not readable: 200"],
      ["a transport error", () => { throw new TypeError(LEAK); }, "Model request failed: no connection."],
      ["any other thrown error", () => { throw new Error(LEAK); }, "Model request failed."],
    ])("from %s", async (_what, respond, expected) => {
      const client = new MetaModelClient({ apiKey: "k", maxRetries: 0, fetchFn: (async () => respond()) as typeof fetch });
      const err = await client.complete({ input: "hi", synthetic: false }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(expected);
      const everything = [
        String(err),
        (err as Error).stack ?? "",
        JSON.stringify(err, Object.getOwnPropertyNames(err)),
        ...logged.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))),
      ].join("\n");
      for (const secret of SECRETS) expect(everything).not.toContain(secret);
    });
  });
});
