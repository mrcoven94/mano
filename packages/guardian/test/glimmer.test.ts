import { describe, expect, it, vi } from "vitest";
import {
  GlimmerChecker,
  glimmerCheckerFromEnv,
} from "../src/glimmer.js";
import type { CheckInput } from "../src/types.js";

function passInput(): CheckInput {
  return {
    action: {
      type: "send",
      recipient: "Sunset Clinic",
      purpose: "Appointment letter",
      payload: { claims: ["Ana Ruiz has an appointment on Friday."] },
      documentHash: null,
    },
    sources: [
      {
        kind: "message",
        id: "m1",
        quote: "Ana Ruiz has an appointment on Friday.",
      },
    ],
    consents: [{ recipient: "Sunset Clinic", purpose: "Appointment letter" }],
    origin: "person",
  };
}

function blockInput(): CheckInput {
  const input = passInput();
  input.origin = "content";
  return input;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completion(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

describe("GlimmerChecker", () => {
  it("returns the model verdict when the rules pass", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(completion('{"verdict": "pass", "problems": []}')),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result).toEqual({ verdict: "pass", problems: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      "https://guardian.example.com/v1/chat/completions",
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["temperature"]).toBe(0);
  });

  it("passes through a fix verdict with its problems", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        completion('{"verdict": "fix", "problems": ["State the exact date."]}'),
      ),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com/",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result).toEqual({
      verdict: "fix",
      problems: ["State the exact date."],
    });
  });

  it("does not call the model when the rules already block", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(completion('{"verdict": "pass", "problems": []}')),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(blockInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/not from the person/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks when the endpoint is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/could not be reached/);
  });

  it("blocks on timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      timeoutMs: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/timed out after 10 seconds/);
  });

  it("aborts the request after the configured timeout", async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation timed out.", "TimeoutError"),
            );
          });
        }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      timeoutMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/timed out/);
  });

  it("blocks on an error status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/returned an error/);
  });

  it("blocks when the body is not JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/could not understand/);
  });

  it("blocks when the model answer is not strict JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(completion("looks fine to me")),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/could not understand/);
  });

  it("blocks when the verdict value is invalid", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(completion('{"verdict": "maybe", "problems": []}')),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
  });

  it("never names models or providers in problem messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const results = await Promise.all([
      checker.check(passInput()),
      checker.check(blockInput()),
    ]);
    for (const result of results) {
      for (const problem of result.problems) {
        expect(problem).not.toMatch(/glimmer|modal|vllm|meta|llama/i);
      }
    }
  });
});

describe("glimmerCheckerFromEnv", () => {
  it("returns null when no endpoint is configured", () => {
    expect(glimmerCheckerFromEnv({})).toBeNull();
    expect(
      glimmerCheckerFromEnv({ MANO_GUARDIAN_URL: "https://x.example.com" }),
    ).toBeNull();
  });

  it("builds a checker from the environment", () => {
    const checker = glimmerCheckerFromEnv({
      MANO_GUARDIAN_URL: "https://x.example.com",
      MANO_GUARDIAN_TOKEN: "token",
    });
    expect(checker).toBeInstanceOf(GlimmerChecker);
  });
});
