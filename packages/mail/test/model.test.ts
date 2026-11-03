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
  strictSchemaErrors,
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
  it("names a refusal by its status in fixed words, without retrying", async () => {
    const billing = { error: { message: "Billing is not configured for this account.", type: "billing_error", code: "billing_not_configured" } };
    const fetchFn = vi.fn(async () => okJson(billing, 402));
    const client = new MetaModelClient({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.responses({ model: "muse-spark-1.3", input: "hi" })).rejects.toThrow(
      "Model request failed: 402 (billing is not set up for this account)",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // Review of PR 109: a 401 body's message reached warnings[].detail
  // word for word. Whatever the provider writes stays out of the error.
  const LEAK = "Key mk-synthetic-7f3a91 is not valid for Maria Santos on case CA-2026-1.";
  const SECRETS = ["mk-synthetic-7f3a91", "Maria Santos", "CA-2026-1"];
  it.each([
    ["a 401", okJson({ error: { message: LEAK, type: "auth_error", code: LEAK } }, 401)],
    ["a 400", okJson({ error: { message: LEAK } }, 400)],
    ["an unlisted 418", okJson({ error: { message: LEAK } }, 418)],
    ["a failed run", okJson({ status: "failed", error: { message: LEAK } })],
    ["a run in an unknown state", okJson({ status: LEAK })],
  ])("never repeats the provider's text from %s", async (_what, response) => {
    const client = new MetaModelClient({ apiKey: "k", maxRetries: 0, fetchFn: (async () => response) as typeof fetch });
    const message = await client.responses({ model: "muse-spark-1.3", input: "hi" }).then(
      () => "resolved",
      (err: Error) => err.message,
    );
    expect(message).toMatch(/^Model (request failed|run)/);
    for (const secret of SECRETS) expect(message).not.toContain(secret);
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

describe("MetaModelClient review 6", () => {
  const completed = (): Response =>
    new Response(JSON.stringify({ status: "completed", output_text: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const req = { model: "muse-spark-1.3", input: "hi" };

  it("calls the global fetch with its own receiver by default", async () => {
    const original = globalThis.fetch;
    // workerd throws when fetch is called with any receiver but the global.
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(completed());
    } as typeof fetch;
    try {
      const client = new MetaModelClient({ apiKey: "k", maxRetries: 0 });
      await expect(client.responses(req)).resolves.toMatchObject({ text: "ok" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stops at a shared deadline instead of waiting out each attempt and retry", async () => {
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const client = new MetaModelClient({ apiKey: "k", timeoutMs: 60_000, maxRetries: 2, fetchFn });
    const started = Date.now();
    await expect(client.responses(req, { deadline: Date.now() + 50 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("makes no request once the deadline has passed", async () => {
    const fetchFn = vi.fn(async () => completed());
    const client = new MetaModelClient({ apiKey: "k", fetchFn });
    await expect(client.responses(req, { deadline: Date.now() - 1 })).rejects.toThrow(/budget/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("strict schemas", () => {
  const detection = (required: string[]) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      detections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { box_2d: { type: "array", items: { type: "number" } }, label: { type: "string" }, score: { type: "number" } },
          required,
        },
      },
    },
    required: ["detections"],
  });

  it("flags a property left out of required, at any depth, as the API does", () => {
    expect(strictSchemaErrors(detection(["box_2d", "label"]))).toEqual([
      "schema.detections[]: Missing 'score' in required",
    ]);
    expect(strictSchemaErrors(detection(["box_2d", "label", "score"]))).toEqual([]);
    expect(strictSchemaErrors({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toEqual([
      "schema: additionalProperties must be false",
    ]);
  });

  it("the stand-in refuses a strict schema the API would refuse, and replays a valid one", async () => {
    const entry = { match: () => true, result: recordedText("{}") };
    const request = (required: string[]) => ({
      model: "sam-3.1",
      input: "x",
      text: { format: { type: "json_schema" as const, name: "mail_detections", schema: detection(required), strict: true } },
    });
    await expect(new RecordedModelClient([entry]).responses(request(["box_2d", "label"]))).rejects.toThrow(
      "Model request failed: 400 (schema.detections[]: Missing 'score' in required)",
    );
    await expect(new RecordedModelClient([entry]).responses(request(["box_2d", "label", "score"]))).resolves.toMatchObject({ text: "{}" });
  });
});
