import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";

// Item 16: the person can see the document they are approving. An
// authenticated route returns the decrypted bytes to the owner only.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function personToken(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

describe("r2 item 16: the owner can download their document", () => {
  it("returns the decrypted bytes to the owner and nobody else", async () => {
    const token = await personToken("r2i16-maria");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const content = "Renewal form bytes for r2i16-maria";
    const registered = await SELF.fetch("https://mano.test/api/persons/r2i16-maria/documents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "renewal.pdf", contentB64: Buffer.from(content).toString("base64") }),
    });
    expect(registered.status).toBe(200);
    const { id } = (await registered.json()) as { id: string };

    const download = await SELF.fetch(`https://mano.test/api/persons/r2i16-maria/documents/${id}`, { headers });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(content);

    const eve = await SELF.fetch(`https://mano.test/api/persons/r2i16-maria/documents/${id}`, {
      headers: { authorization: `Bearer ${await personToken("eve")}` },
    });
    expect(eve.status).toBe(403);

    const missing = await SELF.fetch("https://mano.test/api/persons/r2i16-maria/documents/no-such-doc", { headers });
    expect(missing.status).toBe(404);
  });
});
