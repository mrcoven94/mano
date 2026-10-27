import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  canonicalJson,
  generateAgentKeyPair,
  signMessage,
  validateMessageShape,
  validatePayload,
  verifyMessage,
} from "../src/index.js";

function grantFields(over: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    version: PROTOCOL_VERSION,
    type: "consent.grant",
    caseId: "case-1",
    fromAgentId: "person:maria",
    toAgentId: "org:county",
    payload: { orgAgentId: "org:county", purpose: "renewal", scope: ["documents"] },
    sources: [{ kind: "profile", id: "maria" }],
    approvedByHumanId: "maria",
    idempotencyKey: "idem-1",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("protocol signing", () => {
  it("signs and verifies a consent grant, and rejects tampering", async () => {
    const keys = await generateAgentKeyPair();
    const signed = await signMessage(grantFields() as never, keys.privateKey, keys.publicKeyB64);
    expect(validateMessageShape(signed)).toBe(true);
    expect(await verifyMessage(signed, keys.publicKeyB64)).toBe(true);
    const tampered = { ...signed, payload: { orgAgentId: "org:evil", purpose: "renewal", scope: ["all"] } };
    expect(await verifyMessage(tampered as never, keys.publicKeyB64)).toBe(false);
  });

  it("rejects a validly signed forgery checked against the victim's key", async () => {
    const victim = await generateAgentKeyPair();
    const attacker = await generateAgentKeyPair();
    const forged = await signMessage(
      grantFields({ id: "msg-forged", idempotencyKey: "idem-forged" }) as never,
      attacker.privateKey,
      attacker.publicKeyB64,
    );
    // The signature is real, but it is the attacker's key, not Maria's
    // registry key, so verification against Maria's key fails.
    expect(await verifyMessage(forged, victim.publicKeyB64)).toBe(false);
    expect(await verifyMessage(forged, attacker.publicKeyB64)).toBe(true);
  });

  it("does not depend on key insertion order", async () => {
    const keys = await generateAgentKeyPair();
    const fields = grantFields();
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(fields).reverse()) reordered[key] = fields[key as keyof typeof fields];
    const a = await signMessage(fields as never, keys.privateKey, keys.publicKeyB64);
    const b = await signMessage(reordered as never, keys.privateKey, keys.publicKeyB64);
    expect(a.signature).toBe(b.signature);
    expect(await verifyMessage(b, keys.publicKeyB64)).toBe(true);
  });
});

describe("protocol validation", () => {
  it("rejects missing or wrong versions", async () => {
    const keys = await generateAgentKeyPair();
    const signed = await signMessage(grantFields() as never, keys.privateKey, keys.publicKeyB64);
    expect(validateMessageShape({ ...signed, version: 999 })).toBe(false);
    const { version: _v, ...unversioned } = signed;
    expect(validateMessageShape(unversioned)).toBe(false);
  });

  it("validates each message type's payload schema", () => {
    expect(validatePayload("consent.grant", { orgAgentId: "org:a", purpose: "p", scope: ["x"] })).toBe(true);
    expect(validatePayload("consent.grant", { orgAgentId: "org:a", purpose: "p" })).toBe(false);
    expect(validatePayload("consent.grant", { orgAgentId: "org:a", purpose: "p", scope: "nope" })).toBe(false);
    expect(validatePayload("decision", { outcome: "approved", reason: "r", decidedByHumanId: "h" })).toBe(true);
    expect(validatePayload("decision", { outcome: "maybe", reason: "r", decidedByHumanId: "h" })).toBe(false);
    expect(validatePayload("case.open", { personId: "p", programId: "g", purpose: "u", synthetic: true })).toBe(true);
    expect(validatePayload("case.open", { personId: "p", programId: "g", purpose: "u", synthetic: "yes" })).toBe(false);
    expect(validatePayload("nope", {})).toBe(false);
  });

  it("rejects messages whose payload violates the schema", async () => {
    const keys = await generateAgentKeyPair();
    const signed = await signMessage(
      grantFields({ payload: { orgAgentId: "org:county", purpose: "renewal" } }) as never,
      keys.privateKey,
      keys.publicKeyB64,
    );
    expect(validateMessageShape(signed)).toBe(false);
  });
});

describe("canonical json", () => {
  it("sorts keys and ignores insertion order", () => {
    expect(canonicalJson({ b: 1, a: [3, 2], c: { y: true, x: null } })).toBe(
      '{"a":[3,2],"b":1,"c":{"x":null,"y":true}}',
    );
  });
});
