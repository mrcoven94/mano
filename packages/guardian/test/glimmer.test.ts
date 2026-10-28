import { describe, expect, it, vi } from "vitest";
import {
  GlimmerChecker,
  MisconfiguredChecker,
  glimmerCheckerFromEnv,
} from "../src/glimmer.js";
import { RulesChecker } from "../src/rules.js";
import type { CheckInput } from "../src/types.js";

function passInput(): CheckInput {
  return {
    action: {
      type: "send",
      recipient: "Sunset Clinic",
      purpose: "Appointment letter",
      payload: {
        to: "Sunset Clinic",
        body: "Ana Ruiz has an appointment on Friday. Reach her at ana.ruiz@example.com.",
      },
      documentHash: null,
    },
    sources: [
      {
        kind: "message",
        id: "m1",
        quote:
          "Ana Ruiz has an appointment on Friday. Reach her at ana.ruiz@example.com.",
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

const SERVER = {
  model: { id: "stand-in", revision: "none" },
  image: { tag: "none", digest: "none" },
};

describe("GlimmerChecker", () => {
  it("posts redacted input to the single route", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "pass", problems: [], ...SERVER }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      proxyAuth: { keyId: "key", secret: "secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result).toEqual({ verdict: "pass", problems: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("https://guardian.example.com/check");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      "Modal-Key": "key",
      "Modal-Secret": "secret",
    });
    const sent = init.body as string;
    expect(sent).not.toContain("ana.ruiz@example.com");
    expect(sent).not.toContain("Sunset Clinic");
    expect(sent).toContain("[EMAIL-1]");
    expect(sent).toContain("[RECIPIENT]");
  });

  it("redacts known names before sending", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "pass", problems: [], ...SERVER }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      knownEntities: { names: ["Ana Ruiz"] },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await checker.check(passInput());
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body as string).not.toContain("Ana Ruiz");
  });

  it("passes fix and block verdicts through", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        verdict: "fix",
        problems: ["State the exact date."],
        ...SERVER,
      }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com/",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(checker.check(passInput())).resolves.toEqual({
      verdict: "fix",
      problems: ["State the exact date."],
    });
  });

  it("records the server model and image from the answer", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "pass", problems: [], ...SERVER }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(checker.serverInfo).toBeNull();
    await checker.check(passInput());
    expect(checker.serverInfo).toEqual(SERVER);
  });

  it("ignores malformed server metadata but keeps the verdict", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "pass", problems: [], model: "x" }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(checker.check(passInput())).resolves.toEqual({
      verdict: "pass",
      problems: [],
    });
    expect(checker.serverInfo).toBeNull();
  });

  it("blocks a pass that carries problems", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "pass", problems: ["Wrong recipient"], ...SERVER }),
    );
    const checker = new GlimmerChecker({
      url: "https://guardian.example.com",
      token: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await checker.check(passInput());
    expect(result.verdict).toBe("block");
    expect(result.problems.join(" ")).toMatch(/contradicted/);
  });

  it("blocks fix and block verdicts with no problems", async () => {
    for (const verdict of ["fix", "block"]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ verdict, problems: [], ...SERVER }),
      );
      const checker = new GlimmerChecker({
        url: "https://guardian.example.com",
        token: "token",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const result = await checker.check(passInput());
      expect(result.verdict).toBe("block");
      expect(result.problems.join(" ")).toMatch(/contradicted/);
    }
  });

  it("blocks duplicated verdict keys", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"verdict":"pass","problems":[],"verdict":"pass"}', {
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

  it("does not call the model when the rules already block", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "pass", problems: [], ...SERVER }),
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
    expect(checker.serverInfo).toBeNull();
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

  it("blocks when the verdict value is invalid", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "maybe", problems: [] }),
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
      proxyAuth: { keyId: "key", secret: "secret" },
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
  it("returns rules only when explicitly asked", () => {
    expect(glimmerCheckerFromEnv({ MANO_GUARDIAN_RULES_ONLY: "1" })).toBeInstanceOf(
      RulesChecker,
    );
    expect(
      glimmerCheckerFromEnv({ MANO_GUARDIAN_RULES_ONLY: "true" }),
    ).toBeInstanceOf(RulesChecker);
  });

  it("returns a blocking checker when the endpoint is half configured", async () => {
    const inputs = [
      {},
      { MANO_GUARDIAN_URL: "https://x.example.com" },
      { MANO_GUARDIAN_TOKEN: "token" },
      { MANO_GUARDIAN_URL: "https://x.example.com", MANO_GUARDIAN_TOKEN: "  " },
    ];
    for (const env of inputs) {
      const checker = glimmerCheckerFromEnv(env);
      expect(checker).toBeInstanceOf(MisconfiguredChecker);
      const result = await checker.check(passInput());
      expect(result.verdict).toBe("block");
    }
  });

  it("builds a model checker from a full configuration", () => {
    const checker = glimmerCheckerFromEnv({
      MANO_GUARDIAN_URL: "https://x.example.com",
      MANO_GUARDIAN_TOKEN: "token",
      MANO_GUARDIAN_KEY_ID: "key",
      MANO_GUARDIAN_KEY_SECRET: "secret",
    });
    expect(checker).toBeInstanceOf(GlimmerChecker);
  });
});
