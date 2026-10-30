import { describe, expect, test, vi } from "vitest";
import { FetchModelClient } from "../src/model";

function responder(statuses: Array<number | "throw">) {
  const calls: unknown[][] = [];
  const fetchImpl = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    const next = statuses.shift();
    if (next === "throw") throw new Error("network down");
    if (next === 200) return new Response(JSON.stringify({ id: "resp-1", status: "completed", output: [] }), { status: 200 });
    if (next === undefined) throw new Error("responder ran out of statuses");
    return new Response(JSON.stringify({ error: { message: "bad" } }), { status: next });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const REQUEST = { model: "m", instructions: "i", tools: [{ type: "computer" }], input: [], store: false };

describe("fetch model client", () => {
  test("retries transient failures, then succeeds", async () => {
    const { calls, fetchImpl } = responder(["throw", 503, 200]);
    const client = new FetchModelClient({ baseUrl: "https://model.test", apiKey: "k", fetchImpl, retryDelaysMs: [1, 1, 1] });
    const res = await client.createResponse(REQUEST);
    expect(res.id).toBe("resp-1");
    expect(calls).toHaveLength(3);
  });

  test("gives up after the backoff runs out", async () => {
    const { calls, fetchImpl } = responder([500, 500, 500, 500]);
    const client = new FetchModelClient({ baseUrl: "https://model.test", apiKey: "k", fetchImpl, retryDelaysMs: [1] });
    await expect(client.createResponse(REQUEST)).rejects.toThrow("status 500");
    expect(calls).toHaveLength(2);
  });

  test("never retries a 400", async () => {
    const { calls, fetchImpl } = responder([400]);
    const client = new FetchModelClient({ baseUrl: "https://model.test", apiKey: "k", fetchImpl, retryDelaysMs: [1] });
    await expect(client.createResponse(REQUEST)).rejects.toThrow("status 400");
    expect(calls).toHaveLength(1);
  });

  test("rejects a malformed success", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: 42 }), { status: 200 })) as unknown as typeof fetch;
    const client = new FetchModelClient({ baseUrl: "https://model.test", apiKey: "k", fetchImpl });
    await expect(client.createResponse(REQUEST)).rejects.toThrow("malformed");
  });
});
