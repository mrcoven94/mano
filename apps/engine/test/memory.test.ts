import { SELF, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Engine is the system of record for memory: the agent loop calls these
// as tools over the stub, and the worker exposes the same store over
// authenticated HTTP. Refusals are asserted through HTTP, the house
// pattern, because raw RPC throws pollute the test bridge.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

async function tokenFor(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

describe("memory is authenticated", () => {
  it("stores and lists memories for the verified subject", async () => {
    const person = personStub("r5mem-maria");
    const id = await person.addMemory("r5mem-maria", "Renews plates in March.", "chat");
    expect(typeof id).toBe("string");
    const memories = (await person.listMemory("r5mem-maria")) as { id: string; content: string; source: string }[];
    expect(memories.filter((m) => m.id === id)).toEqual([
      expect.objectContaining({ content: "Renews plates in March.", source: "chat" }),
    ]);
  });

  it("serves memory over authenticated routes and refuses forged tokens", async () => {
    const maria = await tokenFor("r5mem-http");
    const created = await SELF.fetch("https://mano.test/api/persons/r5mem-http/memory", {
      method: "POST",
      headers: { authorization: `Bearer ${maria}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "Prefers morning calls.", source: "chat" }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const listed = await SELF.fetch("https://mano.test/api/persons/r5mem-http/memory", {
      headers: { authorization: `Bearer ${maria}` },
    });
    expect(listed.status).toBe(200);
    const memories = ((await listed.json()) as { memories: { id: string; content: string }[] }).memories;
    expect(memories.filter((m) => m.id === id).map((m) => m.content)).toEqual(["Prefers morning calls."]);

    const eve = await tokenFor("r5mem-eve");
    const forgedGet = await SELF.fetch("https://mano.test/api/persons/r5mem-http/memory", {
      headers: { authorization: `Bearer ${eve}` },
    });
    expect(forgedGet.status).toBe(403);
    const forgedPost = await SELF.fetch("https://mano.test/api/persons/r5mem-http/memory", {
      method: "POST",
      headers: { authorization: `Bearer ${eve}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "Forged.", source: "chat" }),
    });
    expect(forgedPost.status).toBe(403);
  });

  it("rejects memory writes without content and source", async () => {
    const maria = await tokenFor("r5mem-bad");
    const res = await SELF.fetch("https://mano.test/api/persons/r5mem-bad/memory", {
      method: "POST",
      headers: { authorization: `Bearer ${maria}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });
});
