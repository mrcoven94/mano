import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";

// Item 17: request bodies are capped (about 1 MB for actions, 15 MB for
// uploads). /api/check-link needs a person token and answers 200 with
// allowed:false for blocked links instead of 403.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function personToken(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

describe("r2 item 17: body caps and check-link auth", () => {
  it("rejects an oversized action body", async () => {
    const res = await SELF.fetch("https://mano.test/api/persons/r2i17-maria/action", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await personToken("r2i17-maria")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "send", padding: "x".repeat(2_000_000) }),
    });
    expect(res.status).toBe(413);
  });

  it("requires a person token on check-link", async () => {
    const noAuth = await SELF.fetch("https://mano.test/api/check-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    expect(noAuth.status).toBe(403);
  });

  it("answers 200 with allowed:false for a blocked link", async () => {
    const res = await SELF.fetch("https://mano.test/api/check-link", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await personToken("r2i17-maria")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "not a url" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { allowed: boolean }).toMatchObject({ allowed: false });
  });
});
