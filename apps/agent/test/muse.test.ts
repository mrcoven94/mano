import { inspect } from "node:util";

import { APICallError, generateText, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMuseModel } from "../agent/lib/muse.js";

const MARKER = "SYNTHETIC-PRIVATE-MARKER-7f3a";

function completion(): Response {
  return Response.json({
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "x",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "x",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

let bodies: Record<string, unknown>[];
let logs: string[];

function stubFetch(respond: () => Response) {
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return respond();
  });
}

beforeEach(() => {
  bodies = [];
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: Infinity }))).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("model on the public route", () => {
  it("calls the Standard ID with store false even when the data class says synthetic", async () => {
    vi.stubEnv("MANO_DATA_CLASS", "synthetic");
    vi.stubEnv("NODE_ENV", "production");
    stubFetch(completion);
    const { model } = createMuseModel({ apiKey: "test-key" });
    await generateText({ model, prompt: "hello" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe("muse-spark-1.3");
    expect(bodies[0].store).toBe(false);
  });

  it("streams through the Standard ID with store false too", async () => {
    vi.stubEnv("MANO_DATA_CLASS", "synthetic");
    stubFetch(() =>
      sse([
        chunk({ role: "assistant", content: "ok" }),
        chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
        "[DONE]",
      ]),
    );
    const { model } = createMuseModel({ apiKey: "test-key" });
    const result = streamText({ model, prompt: "hello" });
    expect(await result.text).toBe("ok");
    expect(bodies[0].model).toBe("muse-spark-1.3");
    expect(bodies[0].store).toBe(false);
  });
});

describe("model errors", () => {
  const leakingError = () =>
    new Response(JSON.stringify({ error: { message: `overloaded while reading ${MARKER}` } }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "2" },
    });

  it("a failed call surfaces no prompt or response content, but keeps status and retry fields", async () => {
    stubFetch(leakingError);
    const { model } = createMuseModel({ apiKey: "test-key" });
    let caught: unknown;
    try {
      await generateText({ model, prompt: `My address is ${MARKER}`, maxRetries: 0 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const inner = (caught as { lastError?: unknown }).lastError ?? caught;
    expect(inspect(caught, { depth: Infinity })).not.toContain(MARKER);
    expect(logs.join("\n")).not.toContain(MARKER);
    expect(APICallError.isInstance(inner)).toBe(true);
    expect((inner as APICallError).statusCode).toBe(503);
    expect((inner as APICallError).isRetryable).toBe(true);
    expect((inner as APICallError).responseHeaders?.["retry-after"]).toBe("2");
  });

  it("a failed stream surfaces no content in thrown errors, error parts, or logs", async () => {
    stubFetch(leakingError);
    const { model } = createMuseModel({ apiKey: "test-key" });
    const seen: unknown[] = [];
    const result = streamText({
      model,
      prompt: `My address is ${MARKER}`,
      maxRetries: 0,
      onError: ({ error }) => {
        seen.push(error);
      },
    });
    for await (const part of result.fullStream) {
      if (part.type === "error") seen.push(part.error);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const err of seen) expect(inspect(err, { depth: Infinity })).not.toContain(MARKER);
    expect(logs.join("\n")).not.toContain(MARKER);
  });

  it("an error chunk mid-stream is sanitized before it reaches the caller", async () => {
    stubFetch(() =>
      sse([chunk({ role: "assistant", content: "par" }), { error: { message: `failed on ${MARKER}`, code: 500 } }, "[DONE]"]),
    );
    const { model } = createMuseModel({ apiKey: "test-key" });
    const seen: unknown[] = [];
    const result = streamText({
      model,
      prompt: `My address is ${MARKER}`,
      maxRetries: 0,
      onError: ({ error }) => {
        seen.push(error);
      },
    });
    for await (const part of result.fullStream) {
      if (part.type === "error") seen.push(part.error);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const err of seen) expect(inspect(err, { depth: Infinity })).not.toContain(MARKER);
    expect(logs.join("\n")).not.toContain(MARKER);
  });

  it("a stream that fails underneath, after the first chunk, surfaces no content", async () => {
    stubFetch(() => {
      const first = `data: ${JSON.stringify(chunk({ role: "assistant", content: "par" }))}\n\n`;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(first));
            return;
          }
          controller.error(Object.assign(new TypeError(`socket reset while sending ${MARKER}`), { cause: { body: MARKER } }));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const { model } = createMuseModel({ apiKey: "test-key" });
    const seen: unknown[] = [];
    const result = streamText({
      model,
      prompt: `My address is ${MARKER}`,
      maxRetries: 0,
      onError: ({ error }) => {
        seen.push(error);
      },
    });
    try {
      for await (const part of result.fullStream) {
        if (part.type === "error") seen.push(part.error);
      }
    } catch (err) {
      seen.push(err);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const err of seen) expect(inspect(err, { depth: Infinity })).not.toContain(MARKER);
    expect(logs.join("\n")).not.toContain(MARKER);
  });
});

describe("OpenRouter as Modal's backup", () => {
  const MODAL_ROOT = "https://example--ep-test-server.us-west.modal.direct";
  const MODAL_URL = `${MODAL_ROOT}/v1/chat/completions`;
  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

  function settings(openRouterKey = "test-openrouter-key") {
    vi.stubEnv("MANO_MODEL_PROVIDER", "modal");
    vi.stubEnv("MODAL_ENDPOINT_URL", MODAL_ROOT);
    vi.stubEnv("MODAL_PROXY_TOKEN", "wk-test.ws-test");
    vi.stubEnv("OPENROUTER_API_KEY", openRouterKey);
  }

  // Modal's answer is scripted; OpenRouter's is a completion unless told.
  function script(modal: () => Response | Promise<Response>, openRouter: () => Response = () => completion()) {
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
      return String(url) === MODAL_URL ? modal() : openRouter();
    });
    return calls;
  }

  const routeLogs = () => logs.filter((line) => line.includes("mano_model_route")).map((line) => (JSON.parse(line) as { route: string }).route);

  it.each([[429], [500], [503]])("answers from OpenRouter under its pin when Modal says %i, and logs the route", async (code) => {
    settings();
    const calls = script(() => new Response("{}", { status: code }));
    const { model } = createMuseModel();
    await generateText({ model, prompt: "hello", maxRetries: 0 });
    expect(calls.map((c) => c.url)).toEqual([MODAL_URL, OPENROUTER_URL]);
    expect(calls[1]!.auth).toBe("Bearer test-openrouter-key");
    expect(calls[1]!.body.model).toBe("meta/muse-spark-open");
    expect(calls[1]!.body.provider).toEqual({ sort: "latency", zdr: true, data_collection: "deny" });
    expect(routeLogs()).toEqual(["openrouter"]);
  });

  it("answers from OpenRouter when Modal cannot be reached", async () => {
    settings();
    const calls = script(() => Promise.reject(new TypeError("fetch failed")));
    await generateText({ model: createMuseModel().model, prompt: "hello", maxRetries: 0 });
    expect(calls.map((c) => c.url)).toEqual([MODAL_URL, OPENROUTER_URL]);
  });

  it("answers from OpenRouter when Modal does not start answering in time", async () => {
    settings();
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      vi.stubGlobal("fetch", (url: unknown, init?: RequestInit) => {
        calls.push(String(url));
        if (String(url) !== MODAL_URL) return Promise.resolve(completion());
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      });
      const run = generateText({ model: createMuseModel().model, prompt: "hello", maxRetries: 0 });
      await vi.advanceTimersByTimeAsync(30_000);
      await run;
      expect(calls).toEqual([MODAL_URL, OPENROUTER_URL]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses redirects on Modal's call with a backup waiting, and leaves OpenRouter's as it was", async () => {
    settings();
    const redirects: Array<RequestRedirect | undefined> = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return String(url) === MODAL_URL ? new Response("{}", { status: 503 }) : completion();
    });
    await generateText({ model: createMuseModel().model, prompt: "hello", maxRetries: 0 });
    expect(redirects).toEqual(["error", undefined]);
  });

  it("does not touch OpenRouter when Modal answers, and logs that route", async () => {
    settings();
    const calls = script(() => completion());
    await generateText({ model: createMuseModel().model, prompt: "hello" });
    expect(calls.map((c) => c.url)).toEqual([MODAL_URL]);
    expect(routeLogs()).toEqual(["modal"]);
  });

  it.each([[400], [401], [403]])("does not fall back when Modal refuses the request with %i", async (code) => {
    settings();
    const calls = script(() => new Response("{}", { status: code }));
    await expect(generateText({ model: createMuseModel().model, prompt: "hello", maxRetries: 0 })).rejects.toThrow();
    expect(calls.map((c) => c.url)).toEqual([MODAL_URL]);
  });

  it("ends the call when OpenRouter answers 402 too, and tries nothing else", async () => {
    settings();
    const calls = script(() => new Response("{}", { status: 503 }), () => new Response("{}", { status: 402 }));
    await expect(generateText({ model: createMuseModel().model, prompt: "hello", maxRetries: 0 })).rejects.toMatchObject({ statusCode: 402 });
    expect(calls.map((c) => c.url)).toEqual([MODAL_URL, OPENROUTER_URL]);
  });

  it("does not fall back without an OpenRouter key, and missing Modal settings still reach no model", async () => {
    settings("");
    const calls = script(() => new Response("{}", { status: 503 }));
    await expect(generateText({ model: createMuseModel().model, prompt: "hello", maxRetries: 0 })).rejects.toThrow();
    expect(calls.map((c) => c.url)).toEqual([MODAL_URL]);
    settings();
    vi.stubEnv("MODAL_PROXY_TOKEN", "");
    expect(() => createMuseModel()).toThrow("Modal is chosen");
  });
});

describe("OpenRouter switch", () => {
  function stubWithUrls(urls: string[]) {
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return completion();
    });
  }

  it("sends Meta's open-weight model to OpenRouter pinned to zero retention, fastest first, at low effort", async () => {
    vi.stubEnv("MANO_MODEL_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const urls: string[] = [];
    stubWithUrls(urls);
    const { model, modelId } = createMuseModel({ apiKey: "test-key" });
    await generateText({ model, prompt: "hello" });
    expect(modelId).toBe("meta/muse-spark-open");
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(bodies[0].model).toBe("meta/muse-spark-open");
    expect(bodies[0].provider).toEqual({ sort: "latency", zdr: true, data_collection: "deny" });
    expect(bodies[0].reasoning).toEqual({ effort: "low" });
  });

  it("sends Meta's open-weight model to the Modal endpoint with its proxy token, at low effort, with no OpenRouter fields", async () => {
    vi.stubEnv("MANO_MODEL_PROVIDER", "modal");
    vi.stubEnv("MODAL_ENDPOINT_URL", "https://example--ep-test-server.us-west.modal.direct/");
    vi.stubEnv("MODAL_PROXY_TOKEN", "wk-test.ws-test");
    const urls: string[] = [];
    let authorization: string | null = null;
    let redirect: RequestRedirect | undefined;
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      authorization = new Headers(init?.headers).get("authorization");
      redirect = init?.redirect;
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return completion();
    });
    const { model, modelId } = createMuseModel({ apiKey: "test-key" });
    await generateText({ model, prompt: "hello" });
    expect(modelId).toBe("meta-models/Muse-Spark-Open-816B-A42B");
    expect(urls[0]).toBe("https://example--ep-test-server.us-west.modal.direct/v1/chat/completions");
    expect(authorization).toBe("Bearer wk-test.ws-test");
    expect(redirect).toBe("error");
    expect(bodies[0].model).toBe("meta-models/Muse-Spark-Open-816B-A42B");
    expect(bodies[0].reasoning).toEqual({ effort: "low" });
    expect(bodies[0].provider).toBeUndefined();
  });

  it("refuses to build a model when Modal is chosen with its settings incomplete, and calls nothing", () => {
    vi.stubEnv("MANO_MODEL_PROVIDER", "modal");
    vi.stubEnv("MODAL_ENDPOINT_URL", "https://example--ep-test-server.us-west.modal.direct");
    vi.stubEnv("MODAL_PROXY_TOKEN", "");
    vi.stubEnv("META_MODEL_API_KEY", "test-meta-key");
    const urls: string[] = [];
    stubWithUrls(urls);
    expect(() => createMuseModel({ apiKey: "test-key" })).toThrow("Modal is chosen");
    expect(urls).toEqual([]);
  });

  it("stays on the Meta Model API without an OpenRouter key", async () => {
    vi.stubEnv("MANO_MODEL_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const urls: string[] = [];
    stubWithUrls(urls);
    const { model } = createMuseModel({ apiKey: "test-key" });
    await generateText({ model, prompt: "hello" });
    expect(urls[0]).toBe("https://api.meta.ai/v1/chat/completions");
    expect(bodies[0].model).toBe("muse-spark-1.3");
    expect(bodies[0].store).toBe(false);
    expect(bodies[0].provider).toBeUndefined();
    expect(bodies[0].reasoning).toBeUndefined();
    expect(bodies[0].reasoning_effort).toBeUndefined();
  });
});
