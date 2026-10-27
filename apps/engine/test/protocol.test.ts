import { describe, expect, it } from "vitest";
import {
  generateAgentKeyPair,
  signMessage,
  validateMessageShape,
  verifyMessage,
} from "@mano/protocol";

describe("protocol signing", () => {
  it("signs and verifies a consent grant, and rejects tampering", async () => {
    const keys = await generateAgentKeyPair();
    const signed = await signMessage(
      {
        id: "msg-1",
        type: "consent.grant",
        caseId: "case-1",
        fromAgentId: "person:maria",
        toAgentId: "org:county",
        payload: { orgAgentId: "org:county", purpose: "renewal", scope: ["documents"] },
        sources: [{ kind: "profile", id: "maria" }],
        approvedByHumanId: "maria",
        idempotencyKey: "idem-1",
        createdAt: new Date().toISOString(),
      },
      keys.privateKey,
      keys.publicKeyB64,
    );
    expect(validateMessageShape(signed)).toBe(true);
    expect(await verifyMessage(signed, keys.publicKeyB64)).toBe(true);
    const tampered = { ...signed, payload: { orgAgentId: "org:evil", purpose: "renewal", scope: ["all"] } };
    expect(await verifyMessage(tampered as never, keys.publicKeyB64)).toBe(false);
  });

  it("rejects a validly signed forgery checked against the victim's key", async () => {
    const victim = await generateAgentKeyPair();
    const attacker = await generateAgentKeyPair();
    const forged = await signMessage(
      {
        id: "msg-forged",
        type: "consent.grant",
        caseId: "case-1",
        fromAgentId: "person:maria",
        toAgentId: "org:county",
        payload: { orgAgentId: "org:county", purpose: "renewal", scope: ["all"] },
        sources: [],
        approvedByHumanId: "maria",
        idempotencyKey: "idem-forged",
        createdAt: new Date().toISOString(),
      },
      attacker.privateKey,
      attacker.publicKeyB64,
    );
    // The signature is real, but it is the attacker's key, not Maria's
    // registry key, so verification against Maria's key fails.
    expect(await verifyMessage(forged, victim.publicKeyB64)).toBe(false);
    expect(await verifyMessage(forged, attacker.publicKeyB64)).toBe(true);
  });

  it("model client refuses contributor IDs for non-synthetic data", async () => {
    const { MetaModelClient } = await import("../src/model-client.js");
    const client = new MetaModelClient({ apiKey: "test", fetchFn: fetch });
    expect(() => client.resolveModel(false, "muse-spark-1.3-contributor")).toThrow();
    expect(client.resolveModel(true)).toContain("contributor");
    expect(client.resolveModel(false)).not.toContain("contributor");
  });
});
