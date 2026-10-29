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
