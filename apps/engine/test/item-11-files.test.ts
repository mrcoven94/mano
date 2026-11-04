import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import { decryptForPerson, documentAad, encryptForPerson } from "../src/crypto.js";
import { bytesToBase64 } from "../src/hash.js";

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";
const TEST_KEK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async function personToken(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

function b64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

describe("item 11: encrypted file boundary", () => {
  it("uploads a document and approves an action over its server bytes", async () => {
    const token = await personToken("i11maria");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const uploaded = await SELF.fetch("https://mano.test/api/persons/i11maria/documents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "renewal.pdf", contentB64: b64("Form v1: renewal") }),
    });
    expect(uploaded.status).toBe(200);
    const doc = (await uploaded.json()) as { id: string; hash: string };
    expect(doc.id).toBeTruthy();
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);

    const created = await SELF.fetch("https://mano.test/api/persons/i11maria/action", {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "submit",
        recipient: "sandbox-agency",
        purpose: "renewal",
        documentId: doc.id,
        payload: {},
        idempotencyKey: `i11-${crypto.randomUUID()}`,
        actor: "foreground",
      }),
    });
    const pending = (await created.json()) as { status: string; approval?: { id: string; documentHash: string } };
    expect(pending.status).toBe("needs_approval");
    expect(pending.approval?.documentHash).toBe(doc.hash);

    const approved = await SELF.fetch(
      `https://mano.test/api/persons/i11maria/approvals/${pending.approval!.id}/approve`,
      { method: "POST", headers, body: "{}" },
    );
    const done = (await approved.json()) as { status: string };
    expect(done.status).toBe("completed");
  });

  it("blocks actions over unknown document IDs", async () => {
    const token = await personToken("i11ana");
    const res = await SELF.fetch("https://mano.test/api/persons/i11ana/action", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "submit",
        recipient: "sandbox-agency",
        purpose: "renewal",
        documentId: "no-such-doc",
        payload: {},
        idempotencyKey: `i11-${crypto.randomUUID()}`,
        actor: "foreground",
      }),
    });
    const body = (await res.json()) as { status: string; reason?: string };
    expect(body.status).toBe("blocked");
    expect(body.reason).toMatch(/not found/i);
  });

  it("binds ciphertext to the person and document IDs", async () => {
    const plaintext = new TextEncoder().encode("sensitive bytes");
    const blob = await encryptForPerson(plaintext, TEST_KEK_B64, documentAad("maria", "doc-1"));
    const roundtrip = await decryptForPerson(blob, TEST_KEK_B64, documentAad("maria", "doc-1"));
    expect(new TextDecoder().decode(roundtrip)).toBe("sensitive bytes");
    await expect(decryptForPerson(blob, TEST_KEK_B64, documentAad("eve", "doc-1"))).rejects.toThrow();
    await expect(decryptForPerson(blob, TEST_KEK_B64, documentAad("maria", "doc-2"))).rejects.toThrow();
    await expect(decryptForPerson(blob, TEST_KEK_B64)).rejects.toThrow();
  });

  it("fails closed on tampered ciphertext", async () => {
    const blob = await encryptForPerson(new TextEncoder().encode("x"), TEST_KEK_B64, documentAad("m", "d"));
    const bytes = Uint8Array.from(atob(blob.ciphertextB64), (c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    await expect(
      decryptForPerson({ ...blob, ciphertextB64: btoa(s) }, TEST_KEK_B64, documentAad("m", "d")),
    ).rejects.toThrow();
  });
});
