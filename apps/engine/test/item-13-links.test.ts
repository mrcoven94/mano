import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";
import { extractHttpUrls, redactBlockedLinks } from "../src/link-safety.js";

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

  it("refuses invalid URLs on the check endpoint without fetching", async () => {
    const res = await SELF.fetch("https://mano.test/api/check-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not a url", forDisplay: false }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });
});
