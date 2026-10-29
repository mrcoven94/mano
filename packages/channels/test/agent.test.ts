import { describe, expect, it } from "vitest";

import {
  AgentResponder,
  computeSignatureHex,
  ResponderFailed,
  signAgentRequest,
  StandInResponder,
  verifyAgentRequest,
} from "../src/index.js";

const HANDLE = "a".repeat(64);

function responder(fetchFn: typeof fetch, fallback = new StandInResponder(["fallback reply"])): AgentResponder {
  return new AgentResponder({
    agentUrl: "https://agent.example",
    secret: "secret",
    handleHash: HANDLE,
    fallback,
    timeoutMs: 1000,
    fetchFn,
    nowSeconds: () => 1_761_777_000,
  });
}

describe("agent verifier", () => {
  it("matches the shared interop vector", async () => {
    // apps/agent/test/auth.test.ts pins this same vector through the
    // Node signer, proving both sides interoperate.
    expect(await computeSignatureHex("interop-secret", "1761777000", '{"handleHash":"ab"}')).toBe(
      "042f17f9f8d6de11a23f0ca0c1ae55daba175a48af001583e909d62407e37096",
    );
  });

  it("verifies a signed body and rejects the rest", async () => {
    const raw = new TextEncoder().encode(JSON.stringify({ handleHash: HANDLE }));
    const sig = await signAgentRequest("secret", 1000, raw);
    expect((await verifyAgentRequest("secret", "1000", sig, raw, 1000)).ok).toBe(true);
    expect(await verifyAgentRequest("secret", "1000", sig, new TextEncoder().encode("x"), 1000)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyAgentRequest("secret", "1", await signAgentRequest("secret", 1, raw), raw, 1000)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(await verifyAgentRequest("secret", "soon", sig, raw, 1000)).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(await verifyAgentRequest(undefined, "1000", sig, raw, 1000)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("agent responder", () => {
  it("returns the agent reply with a signed request", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ status: "replied", text: "Agent says hi." });
    }) as typeof fetch;
    const result = await responder(fetchFn).respond({ texts: ["hi"], attachmentCount: 0 });
    expect(result.model).toBe("agent");
    expect(result.text).toBe("Agent says hi.");
    expect(result.attempts).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://agent.example/channels/mano/turn");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["x-mano-timestamp"]).toBe("1761777000");
    expect(headers["x-mano-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ handleHash: HANDLE, texts: ["hi"], attachmentCount: 0 });
  });

  it("accepts a parked approval question as the reply", async () => {
    const fetchFn = (async () => Response.json({ status: "waiting_input", text: "Submit? Reply YES or NO." })) as typeof fetch;
    const result = await responder(fetchFn).respond({ texts: ["submit it"], attachmentCount: 0 });
    expect(result.model).toBe("agent");
    expect(result.text).toBe("Submit? Reply YES or NO.");
  });

  it("falls back on agent timeout, failure, or empty reply", async () => {
    const failing: Array<typeof fetch> = [
      (async () => {
        throw new Error("timeout");
      }) as typeof fetch,
      (async () => Response.json({ status: "error", text: "" }, { status: 502 })) as typeof fetch,
      (async () => Response.json({ status: "replied", text: "  " })) as typeof fetch,
    ];
    for (const fetchFn of failing) {
      const result = await responder(fetchFn).respond({ texts: ["hi"], attachmentCount: 0 });
      expect(result.model).toBe("stand-in");
      expect(result.attempts).toBe(2);
    }
  });

  it("counts the agent attempt when the fallback fails too", async () => {
    const fetchFn = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    const fallback = new StandInResponder([]);
    fallback.respond = async () => {
      throw new ResponderFailed("Fallback failed.", 3, 10, "http_500");
    };
    const err = await responder(fetchFn, fallback).respond({ texts: ["hi"], attachmentCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).attempts).toBe(4);
  });

  it("requires its config", () => {
    const fallback = new StandInResponder();
    expect(() => new AgentResponder({ agentUrl: "", secret: "s", handleHash: HANDLE, fallback })).toThrow();
    expect(() => new AgentResponder({ agentUrl: "https://x", secret: "", handleHash: HANDLE, fallback })).toThrow();
  });
});
