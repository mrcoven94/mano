import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import type { PersonAgent } from "../src/agents/person-agent.js";
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

// Review of PR 83: what a delete or a racing upload can leave behind.
// Every object under the person's documents prefix must have its row,
// and every row its object.
async function storedState(h: string) {
  const personId = personIdForHandle(h);
  const objects = (await (testEnv.FILES as R2Bucket).list({ prefix: `persons/${personId}/docs/` })).objects.map((o) => o.key).sort();
  const stub = (testEnv.PERSON_AGENT as DurableObjectNamespace).get((testEnv.PERSON_AGENT as DurableObjectNamespace).idFromName(personId));
  const rows = await runInDurableObject(stub, (_i, state) =>
    (state.storage.sql.exec("SELECT id, hash, r2_key FROM documents").toArray() as { id: string; hash: string; r2_key: string }[]),
  );
  return { objects, rows };
}

function agentFor(h: string) {
  const personId = personIdForHandle(h);
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return { personId, stub: ns.get(ns.idFromName(personId)) };
}

describe("review of PR 83: uploads racing deletes and each other", () => {
  it("blocker 3: an upload landing while the conversation is deleted leaves no object without a row", async () => {
    for (const order of ["upload-first", "delete-first"] as const) {
      const h = handle(`doc-race-${order}`);
      const { personId, stub } = agentFor(h);
      expect((await upload(h, "g0t1i0-before1", "photo-before")).status).toBe(200);
      await runInDurableObject(stub, async (instance) => {
        const agent = instance as unknown as PersonAgent;
        // R2 deletes take a moment, so the upload runs while the delete waits.
        const env = (agent as unknown as { env: { FILES: R2Bucket } }).env;
        const files = env.FILES;
        env.FILES = new Proxy(files, {
          get(target, prop) {
            if (prop === "delete") {
              return async (keys: string | string[]) => {
                await new Promise((r) => setTimeout(r, 100));
                return target.delete(keys);
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const up = () => agent.registerDocument(personId, { id: "g0t2i0-during1", name: "during.jpg", contentB64: b64("photo-during") }, 0);
        const del = () => agent.deleteConversation(personId, { generation: 1 });
        try {
          await Promise.all(order === "upload-first" ? [up(), del()] : [del(), up()]);
        } finally {
          env.FILES = files;
        }
      });
      const { objects, rows } = await storedState(h);
      expect({ order, objects, rows }).toEqual({ order, objects: [], rows: [] });
    }
  });

  it("should-fix 4: two uploads with one ID and different bytes leave the winner intact, and the loser gets a conflict", async () => {
    const h = handle("doc-two-writers");
    const { personId, stub } = agentFor(h);
    const results = await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as PersonAgent;
      return Promise.all([
        agent.registerDocument(personId, { id: "g0t1i0-same001", name: "a.jpg", contentB64: b64("bytes-one") }, 0),
        agent.registerDocument(personId, { id: "g0t1i0-same001", name: "b.jpg", contentB64: b64("bytes-two") }, 0),
      ]);
    });
    const winners = results.filter((r) => "id" in r);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => "conflict" in r)).toHaveLength(1);
    const { objects, rows } = await storedState(h);
    expect(rows).toHaveLength(1);
    expect(objects).toEqual([rows[0]!.r2_key]);
    const read = await call(h, "GET", "/documents/g0t1i0-same001", undefined, AGENT_TOKEN);
    const expected = (winners[0] as { hash: string }).hash === rows[0]!.hash ? rows[0]!.hash : null;
    expect(expected).not.toBeNull();
    const body = new TextDecoder().decode(await read.arrayBuffer());
    expect(["bytes-one", "bytes-two"]).toContain(body);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe(rows[0]!.hash);
  });
});
