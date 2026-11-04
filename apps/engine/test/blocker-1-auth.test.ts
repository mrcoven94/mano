import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function personToken(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

describe("blocker 1: identity comes from signed session tokens", () => {
  it("rejects a forged x-person-id header", async () => {
    const res = await SELF.fetch("https://mano.test/api/persons/b1maria/approvals", {
      headers: { "x-person-id": "b1maria" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a self-asserted bearer name", async () => {
    const res = await SELF.fetch("https://mano.test/api/persons/b1maria/approvals", {
      headers: { authorization: "Bearer b1maria" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = await mintSessionToken({ kind: "person", sub: "b1maria" }, "wrong-secret");
    const res = await SELF.fetch("https://mano.test/api/persons/b1maria/approvals", {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects one person's token on another person's route", async () => {
    const token = await personToken("eve");
    const res = await SELF.fetch("https://mano.test/api/persons/b1maria/approvals", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a valid signed token on the matching route", async () => {
    const token = await personToken("b1maria");
    const res = await SELF.fetch("https://mano.test/api/persons/b1maria/approvals", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
