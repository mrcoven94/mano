import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";

// Forget deletes the memory row from the person's own SQLite. A second
// forget answers the same, and another person cannot forget it.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function call(personId: string, path: string, init: RequestInit = {}, sub = personId) {
  const token = await mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personId}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

async function memoryRows(personId: string, memoryId: string): Promise<number> {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return runInDurableObject(ns.get(ns.idFromName(personId)), (_i, state) => {
    const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM memory WHERE id = ?", memoryId).toArray();
    return (rows[0] as { n: number }).n;
  });
}

describe("DELETE /api/persons/:id/memory/:memoryId", () => {
  it("deletes the row, idempotently", async () => {
    const personId = "live2-maria";
    const added = await call(personId, "/memory", {
      method: "POST",
      body: JSON.stringify({ content: "Renewal letter arrived Oct 20.", source: "text" }),
    });
    const { id } = (await added.json()) as { id: string };
    expect(await memoryRows(personId, id)).toBe(1);

    const first = await call(personId, `/memory/${id}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id, forgotten: true });
    expect(await memoryRows(personId, id)).toBe(0);
    const list = (await (await call(personId, "/memory")).json()) as { memories: { id: string }[] };
    expect(list.memories.map((m) => m.id)).not.toContain(id);

    const second = await call(personId, `/memory/${id}`, { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id, forgotten: true });
  });

  it("refuses another person's token and keeps the row", async () => {
    const personId = "live2-owner";
    const added = await call(personId, "/memory", {
      method: "POST",
      body: JSON.stringify({ content: "Prefers texts after 5pm.", source: "text" }),
    });
    const { id } = (await added.json()) as { id: string };
    const res = await call(personId, `/memory/${id}`, { method: "DELETE" }, "live2-intruder");
    expect(res.status).toBe(403);
    expect(await memoryRows(personId, id)).toBe(1);
  });
});
