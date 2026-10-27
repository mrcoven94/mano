import { describe, expect, it, vi } from "vitest";
import {
  MetaModelClient,
  RecordedModelClient,
  baseUrlFromEnv,
  extractOutputText,
  extractUsage,
  isContributorId,
  readingModelFor,
  recordedText,
} from "../src/model.js";

describe("readingModelFor", () => {
  it("uses the contributor ID only for synthetic data", () => {
    expect(readingModelFor(true)).toBe("muse-spark-1.3-contributor");
    expect(readingModelFor(false)).toBe("muse-spark-1.3");
  });
  it("detects contributor IDs", () => {
    expect(isContributorId("muse-spark-1.3-contributor")).toBe(true);
    expect(isContributorId("muse-spark-1.3")).toBe(false);
  });
});

describe("extractOutputText", () => {
  it("reads output_text parts", () => {
    const data = { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] };
    expect(extractOutputText(data)).toBe("hi");
  });
  it("reads output_text shorthand", () => {
    expect(extractOutputText({ output_text: "hi" })).toBe("hi");
  });
  it("returns empty string for unknown shapes", () => {
    expect(extractOutputText({})).toBe("");
  });
});

describe("extractUsage", () => {
  it("reads token counts", () => {
    expect(extractUsage({ usage: { input_tokens: 3, output_tokens: 5 } })).toEqual({ inputTokens: 3, outputTokens: 5 });
  });
  it("returns null when absent", () => {
    expect(extractUsage({})).toBeNull();
  });
});

describe("baseUrlFromEnv", () => {
  it("prefers the AI gateway when configured", () => {
    expect(baseUrlFromEnv({ CF_ACCOUNT_ID: "a", AI_GATEWAY_ID: "g" })).toBe(
      "https://gateway.ai.cloudflare.com/v1/a/g/meta",
    );
  });
  it("goes direct otherwise", () => {
    expect(baseUrlFromEnv({})).toBe("https://api.meta.ai/v1");
  });
});

describe("MetaModelClient", () => {
  function okJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  it("posts store:false and extracts text", async () => {
    const fetchFn = vi.fn(async () => okJson({ status: "completed", output_text: "done", usage: { input_tokens: 1, output_tokens: 2 } }));
    const client = new MetaModelClient({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch });
    const res = await client.responses({ model: "muse-spark-1.3", input: "hi" });
    expect(res.text).toBe("done");
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(sent["store"]).toBe(false);
    expect(sent["model"]).toBe("muse-spark-1.3");
    expect((call[1].headers as Record<string, string>)["authorization"]).toBe("Bearer k");
  });
  it("rejects contributor IDs for non-synthetic clients", async () => {
    const fetchFn = vi.fn();
    const client = new MetaModelClient({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.responses({ model: "muse-spark-1.3-contributor", input: "hi" })).rejects.toThrow(
      "only allowed for synthetic",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("allows contributor IDs for synthetic clients", async () => {
    const fetchFn = vi.fn(async () => okJson({ status: "completed", output_text: "ok" }));
    const client = new MetaModelClient({ apiKey: "k", synthetic: true, fetchFn: fetchFn as unknown as typeof fetch });
    await client.responses({ model: "muse-spark-1.3-contributor", input: "hi" });
    expect(fetchFn).toHaveBeenCalled();
  });
  it("rejects unknown model IDs", async () => {
    const fetchFn = vi.fn();
    const client = new MetaModelClient({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.responses({ model: "other-model", input: "hi" })).rejects.toThrow("Unknown model ID");
  });
  it("retries 429 then succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({}, 429))
      .mockResolvedValueOnce(okJson({ status: "completed", output_text: "ok" }));
    const client = new MetaModelClient({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch });
    const res = await client.responses({ model: "muse-spark-1.3", input: "hi" });
    expect(res.text).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("RecordedModelClient", () => {
  it("replays matched recordings and records calls", async () => {
    const client = new RecordedModelClient([
      { match: (req) => req.model === "sam-3.1", result: recordedText('{"detections":[]}') },
    ]);
    const res = await client.responses({ model: "sam-3.1", input: "img" });
    expect(res.text).toBe('{"detections":[]}');
    expect(res.model).toBe("sam-3.1");
    expect(client.calls).toHaveLength(1);
    expect(client.live).toBe(false);
  });
  it("fails closed on unmatched requests", async () => {
    const client = new RecordedModelClient([]);
    await expect(client.responses({ model: "muse-spark-1.3", input: "hi" })).rejects.toThrow("No recorded response");
  });
});
