import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";

// Photos texted to the line: Channels stores each one in the person's
// encrypted documents under an ID it derives from the turn, the agent
// reads it back to read the letter, and deleting the conversation
// deletes them. The agent may call POST /deadlines; until that route
// exists it answers 404, which the agent reads as "not available".

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(handleHash: string, method: string, path: string, body: unknown, token: string) {
  const grant = await mintHandleGrant(handleHash, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(handleHash)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const b64 = (text: string) => btoa(text);
const upload = (h: string, id: string, text: string, generation = 0) =>
  call(h, "POST", "/documents", { id, name: `${id}.jpg`, contentB64: b64(text), generation }, CHANNELS_TOKEN);

describe("texted photos", () => {
  it("Channels stores a photo once under its own ID, and the agent reads it back", async () => {
    const h = handle("doc-store");
    const first = await upload(h, "g0t1i0-abc123", "synthetic-photo-bytes");
    expect(first.status).toBe(200);
    const stored = (await first.json()) as { id: string; hash: string };
    expect(stored.id).toBe("g0t1i0-abc123");

    // A retried upload of the same photo is the same document.
    const again = await upload(h, "g0t1i0-abc123", "synthetic-photo-bytes");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(stored);
    // Different bytes under the same ID are refused, never overwritten.
    expect((await upload(h, "g0t1i0-abc123", "other-bytes")).status).toBe(409);

    const read = await call(h, "GET", "/documents/g0t1i0-abc123", undefined, AGENT_TOKEN);
    expect(read.status).toBe(200);
    expect(new TextDecoder().decode(await read.arrayBuffer())).toBe("synthetic-photo-bytes");
  });

  it("each service has only its own document route", async () => {
    const h = handle("doc-scope");
    expect((await upload(h, "g0t1i0-scope1", "bytes")).status).toBe(200);
    expect((await call(h, "GET", "/documents/g0t1i0-scope1", undefined, CHANNELS_TOKEN)).status).toBe(403);
    expect(
      (await call(h, "POST", "/documents", { id: "g0t1i0-scope2", name: "x.jpg", contentB64: b64("x"), generation: 0 }, AGENT_TOKEN)).status,
    ).toBe(403);
    // A service write names its generation.
    expect((await call(h, "POST", "/documents", { id: "g0t1i0-scope3", name: "x.jpg", contentB64: b64("x") }, CHANNELS_TOKEN)).status).toBe(400);
    // Service IDs are slug-safe.
    expect((await upload(h, "../escape", "x")).status).toBe(400);
  });

  it("deleting the conversation deletes its photos, and a late upload from before the delete is refused", async () => {
    const h = handle("doc-delete");
    expect((await upload(h, "g0t2i0-del001", "photo-one")).status).toBe(200);
    const removed = await call(h, "DELETE", "/conversation", { generation: 1 }, CHANNELS_TOKEN);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { removed: { documentsDeleted: number } }).removed.documentsDeleted).toBe(1);
    expect((await call(h, "GET", "/documents/g0t2i0-del001", undefined, AGENT_TOKEN)).status).toBe(404);
    const objects = await (testEnv.FILES as R2Bucket).list({ prefix: `persons/${personIdForHandle(h)}/docs/` });
    expect(objects.objects).toHaveLength(0);

    expect((await upload(h, "g0t2i1-late01", "late", 0)).status).toBe(409);
    expect((await (testEnv.FILES as R2Bucket).list({ prefix: `persons/${personIdForHandle(h)}/docs/` })).objects).toHaveLength(0);
    expect((await upload(h, "g1t1i0-new001", "new", 1)).status).toBe(200);
  });

  it("the agent may call POST /deadlines; without the route it is a 404, never a 403", async () => {
    const h = handle("doc-deadline");
    const res = await call(
      h,
      "POST",
      "/deadlines",
      { title: "Renewal", dueDate: "2026-11-20", source: { kind: "letter", documentId: "g0t1i0-abc123", sentence: "Due." }, idempotencyKey: "k1" },
      AGENT_TOKEN,
    );
    expect(res.status).not.toBe(403);
  });
});
