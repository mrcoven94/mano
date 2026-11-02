import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";
import { checkLinkSafety, extractHttpUrls, redactBlockedLinks } from "../src/link-safety.js";

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "send",
    recipient: "sandbox-agency",
    purpose: "notice",
    payload: {},
    idempotencyKey: `key-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("item 13: enforced link checks", () => {
  it("blocks an action to a blocked URL recipient", async () => {
    const seen: string[] = [];
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      linkCheck: async (url) => {
        seen.push(url);
        return url.includes("evil.example") ? { allowed: false, reason: "Blocked domain." } : { allowed: true };
      },
    });
    const result = await gw.requestAction(baseReq({ recipient: "https://evil.example.com/click" }));
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/link check failed/i);
    expect(seen).toContain("https://evil.example.com/click");
  });

  it("blocks an action whose payload link is blocked", async () => {
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      linkCheck: async () => ({ allowed: false, reason: "Blocked domain." }),
    });
    const result = await gw.requestAction(baseReq({ payload: { url: "https://evil.example.com/x" } }));
    expect(result.status).toBe("blocked");
  });

  it("lets clean actions through and skips non-URL recipients", async () => {
    let calls = 0;
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      linkCheck: async () => {
        calls++;
        return { allowed: true };
      },
    });
    const result = await gw.requestAction(baseReq());
    expect(result.status).toBe("needs_approval");
    expect(calls).toBe(0);
  });

  it("redacts blocked links from person-visible text and fails closed on errors", async () => {
    expect(extractHttpUrls("see https://a.example/x, and http://b.example/y!")).toEqual([
      "https://a.example/x",
      "http://b.example/y",
    ]);
    const out = await redactBlockedLinks("click https://evil.example/x then https://ok.example/y", async (url) => ({
      allowed: !url.includes("evil"),
    }));
    expect(out.text).toBe("click [blocked link] then https://ok.example/y");
    expect(out.blocked).toEqual(["https://evil.example/x"]);
    const errored = await redactBlockedLinks("click https://flaky.example/", async () => {
      throw new Error("dns down");
    });
    expect(errored.text).toBe("click [blocked link]");
  });

  it("checks every link at once and still reports the first block in order", async () => {
    let inFlight = 0;
    let most = 0;
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      linkCheck: async (url) => {
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, url.includes("one") ? 20 : 1));
        inFlight--;
        return url.includes("example.org") ? { allowed: true } : { allowed: false, reason: "Blocked domain." };
      },
    });
    const result = await gw.requestAction(
      baseReq({ payload: { a: "https://one.example.net/x", b: "https://two.example.net/y", c: "https://ok.example.org/" } }),
    );
    expect(most).toBe(3);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("one.example.net");
  });

  it("asks both resolvers at once for a link shown to a person", async () => {
    let inFlight = 0;
    let most = 0;
    const fetchFn = (async (input: string) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const family = String(input).startsWith("https://family.");
      return Response.json({ Answer: [{ type: 1, data: family ? "0.0.0.0" : "93.184.216.34" }] });
    }) as unknown as typeof fetch;
    expect(await checkLinkSafety("https://kids.example.com/", { forDisplay: true, fetchFn })).toEqual({
      allowed: false,
      reason: "Blocked domain.",
    });
    expect(most).toBe(2);
  });

  it("refuses invalid URLs on the check endpoint without fetching", async () => {
    const token = await mintSessionToken({ kind: "person", sub: "i13maria" }, TEST_SESSION_SECRET);
    const res = await SELF.fetch("https://mano.test/api/check-link", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "not a url", forDisplay: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });
});
