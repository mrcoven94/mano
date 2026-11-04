import { env as testEnv, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import { MetaModelClient } from "../src/model-client.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

describe("blocker 8: the caller never picks the model", () => {
  it("has no public model route", async () => {
    const token = await mintSessionToken({ kind: "person", sub: "b8maria" }, TEST_SESSION_SECRET);
    const res = await SELF.fetch("https://mano.test/api/persons/b8maria/model", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", synthetic: true, model: "muse-spark-1.3-contributor" }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses contributor models for non-synthetic data and unknown IDs", () => {
    const client = new MetaModelClient({ apiKey: "test-key-not-real" });
    expect(() => client.resolveModel(false, "muse-spark-1.3-contributor")).toThrow();
    expect(() => client.resolveModel(true, "not-a-model")).toThrow();
    expect(() => client.resolveModel(false, "not-a-model")).toThrow();
    expect(client.resolveModel(true)).toBe("muse-spark-1.3-contributor");
    expect(client.resolveModel(false)).toBe("muse-spark-1.3");
  });

  it("lets the agent resolve synthetic from its own profile, not the request", async () => {
    const person = personStub("b8-person");
    // The operator=false guard stays as defense in depth; enforcement is
    // covered over HTTP in r2-item-14 (wrong secret 403s, the operator
    // secret flips the flag).
    await person.setSyntheticFlag(true, "b8maria", true);
    expect(await person.getModelInfo("b8maria")).toEqual({
      synthetic: true,
      model: "muse-spark-1.3-contributor",
    });
    await person.setSyntheticFlag(true, "b8maria", false);
    expect(await person.getModelInfo("b8maria")).toEqual({ synthetic: false, model: "muse-spark-1.3" });
  });
});
