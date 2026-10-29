import { describe, expect, it } from "vitest";
import { verifyHandleGrant } from "@mano/protocol";

import {
  AgentResponder,
  computeSignatureHex,
  notifyAgentDeleted,
  ResponderFailed,
  signAgentRequest,
  StandInResponder,
  verifyAgentRequest,
} from "../src/index.js";

const HANDLE = "a".repeat(64);
const KEY = { generation: 0, turn: 1 };

function responder(fetchFn: typeof fetch, fallback = new StandInResponder(["fallback reply"])): AgentResponder {
  return new AgentResponder({
    agentUrl: "https://agent.example",
    secret: "secret",
    grantSecret: "grant-secret",
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
    const result = await responder(fetchFn).respond({ texts: ["hi"], attachmentCount: 0, turnKey: KEY });
    expect(result.model).toBe("agent");
    expect(result.text).toBe("Agent says hi.");
    expect(result.attempts).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://agent.example/channels/mano/turn");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["x-mano-timestamp"]).toBe("1761777000");
    expect(headers["x-mano-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(seen[0].init.body as string)).toMatchObject({ handleHash: HANDLE, texts: ["hi"], attachmentCount: 0 });
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
      const result = await responder(fetchFn).respond({ texts: ["hi"], attachmentCount: 0, turnKey: KEY });
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
    const err = await responder(fetchFn, fallback).respond({ texts: ["hi"], attachmentCount: 0, turnKey: KEY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponderFailed);
    expect((err as ResponderFailed).attempts).toBe(4);
  });

  it("requires its config", () => {
    const fallback = new StandInResponder();
    expect(() => new AgentResponder({ agentUrl: "", secret: "s", grantSecret: "g", handleHash: HANDLE, fallback })).toThrow();
    expect(() => new AgentResponder({ agentUrl: "https://x", secret: "", grantSecret: "g", handleHash: HANDLE, fallback })).toThrow();
    expect(() => new AgentResponder({ agentUrl: "https://x", secret: "s", grantSecret: "", handleHash: HANDLE, fallback })).toThrow();
  });
});

describe("agent turn identity and grant", () => {
  const GRANT_SECRET = "grant-secret-for-tests";

  function capturing(seen: Record<string, unknown>[]) {
    return (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return Response.json({ status: "replied", text: "ok" });
    }) as typeof fetch;
  }

  function withGrant(fetchFn: typeof fetch): AgentResponder {
    return new AgentResponder({
      agentUrl: "https://agent.example",
      secret: "secret",
      grantSecret: GRANT_SECRET,
      handleHash: HANDLE,
      fallback: new StandInResponder(["fallback reply"]),
      timeoutMs: 1000,
      fetchFn,
    });
  }

  it("signs a stable turn ID and the deletion generation inside the body", async () => {
    const seen: Record<string, unknown>[] = [];
    const agent = withGrant(capturing(seen));
    await agent.respond({ texts: ["hi"], attachmentCount: 0, turnKey: { generation: 2, turn: 7 } });
    await agent.respond({ texts: ["hi"], attachmentCount: 0, turnKey: { generation: 2, turn: 7 } });
    await agent.respond({ texts: ["hi"], attachmentCount: 0, turnKey: { generation: 2, turn: 8 } });
    expect(seen[0].turnId).toBe(`${HANDLE}:2:7`);
    expect(seen[1].turnId).toBe(seen[0].turnId);
    expect(seen[2].turnId).toBe(`${HANDLE}:2:8`);
    expect(seen[0].generation).toBe(2);
  });

  it("passes a handle grant the engine verifies for exactly this handle", async () => {
    const seen: Record<string, unknown>[] = [];
    await withGrant(capturing(seen)).respond({ texts: ["hi"], attachmentCount: 0, turnKey: { generation: 0, turn: 1 } });
    const claims = await verifyHandleGrant(String(seen[0].grant), GRANT_SECRET);
    expect(claims?.handle).toBe(HANDLE);
    expect(await verifyHandleGrant(String(seen[0].grant), "other-secret")).toBeNull();
  });

  it("answers from the fallback when the turn has no stable key", async () => {
    const seen: Record<string, unknown>[] = [];
    const result = await withGrant(capturing(seen)).respond({ texts: ["hi"], attachmentCount: 0 });
    expect(seen).toHaveLength(0);
    expect(result.text).toBe("fallback reply");
  });

  it("accepts a reply that carries an approval question", async () => {
    const approval = "Ready to send: renewal. Name: Rosa Testcase. Reply YES to send exactly this, or NO to stop.";
    const fetchFn = (async () => Response.json({ status: "waiting_approval", text: `It is ready.\n\n${approval}`, approval })) as typeof fetch;
    const result = await withGrant(fetchFn).respond({ texts: ["file it"], attachmentCount: 0, turnKey: { generation: 0, turn: 1 } });
    expect(result.model).toBe("agent");
    expect(result.text).toContain("Reply YES");
  });
});

describe("agent deletion notice", () => {
  it("signs the handle, the new generation and a grant for the agent", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const ok = await notifyAgentDeleted({
      agentUrl: "https://agent.example/",
      secret: "secret",
      grantSecret: "grant-secret-for-tests",
      handleHash: HANDLE,
      generation: 3,
      fetchFn,
      nowSeconds: 1000,
    });
    expect(ok).toBe(true);
    expect(seen[0].url).toBe("https://agent.example/channels/mano/deleted");
    const raw = new TextEncoder().encode(String(seen[0].init.body));
    const headers = seen[0].init.headers as Record<string, string>;
    expect((await verifyAgentRequest("secret", headers["x-mano-timestamp"], headers["x-mano-signature"], raw, 1000)).ok).toBe(true);
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ handleHash: HANDLE, generation: 3 });
    expect((await verifyHandleGrant(body.grant, "grant-secret-for-tests"))?.handle).toBe(HANDLE);
  });

  it("reports a refused notice", async () => {
    const fetchFn = (async () => new Response("no", { status: 503 })) as typeof fetch;
    expect(
      await notifyAgentDeleted({ agentUrl: "https://a", secret: "s", grantSecret: "g", handleHash: HANDLE, generation: 1, fetchFn }),
    ).toBe(false);
  });
});

describe("approval questions on the text line", () => {
  function answering(body: Record<string, unknown>): AgentResponder {
    return new AgentResponder({
      agentUrl: "https://agent.example",
      secret: "secret",
      grantSecret: "g",
      handleHash: HANDLE,
      fallback: new StandInResponder(["fallback reply"]),
      fetchFn: (async () => Response.json(body)) as typeof fetch,
    });
  }

  it("refuses a question the voice guard would change, rather than send an altered one", async () => {
    const approval = "Ready to send: renewal. Name: Claude Testcase; Phone: 555-0100. Reply YES to send exactly this, or NO to stop.";
    const result = await answering({ status: "waiting_approval", text: `Ready.\n\n${approval}`, approval }).respond({
      texts: ["file it"],
      attachmentCount: 0,
      turnKey: KEY,
    });
    expect(result.text).not.toContain("Reply YES");
    expect(result.text).toMatch(/not.*approve|do not reply yes/i);
  });

  it("refuses an approval reply whose text does not carry the question word for word", async () => {
    const approval = "Ready to send: renewal. Name: Rosa Testcase. Reply YES to send exactly this, or NO to stop.";
    const result = await answering({ status: "waiting_approval", text: "Ready. Reply YES to send it.", approval }).respond({
      texts: ["file it"],
      attachmentCount: 0,
      turnKey: KEY,
    });
    expect(result.text).not.toContain("Reply YES");
  });
});
