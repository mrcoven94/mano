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
    expect(await verifyMessage(signed)).toBe(true);
    const tampered = { ...signed, payload: { orgAgentId: "org:evil", purpose: "renewal", scope: ["all"] } };
    expect(await verifyMessage(tampered as never)).toBe(false);
  });

  it("model client refuses contributor IDs for non-synthetic data", async () => {
    const { MetaModelClient } = await import("../src/model-client.js");
    const client = new MetaModelClient({ apiKey: "test", fetchFn: fetch });
    expect(() => client.resolveModel(false, "muse-spark-1.3-contributor")).toThrow();
    expect(client.resolveModel(true)).toContain("contributor");
    expect(client.resolveModel(false)).not.toContain("contributor");
  });
});
