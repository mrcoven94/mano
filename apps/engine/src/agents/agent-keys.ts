import type { Env } from "../env.js";

// Agent keys. Each agent owns an Ed25519 keypair; Mano verifies protocol
// messages against the sender's key resolved from the sender's own agent
// stub (a namespace lookup no caller can forge), cached in the receiver's
// agent_keys table. No key from inside a message is ever trusted.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function generateAgentKeypair(): Promise<{
  privateJwk: JsonWebKey;
  publicKeyB64: string;
}> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { privateJwk, publicKeyB64: bytesToB64(new Uint8Array(raw)) };
}

export async function importAgentPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["sign"]);
}

// Resolves an agent ID ("person:<id>" or "org:<id>") to its public key by
// asking the authoritative stub. Returns null for unknown IDs or errors.
export async function resolveAgentKey(env: Env, agentId: string): Promise<string | null> {
  const match = /^(person|org):([A-Za-z0-9_-]+)$/.exec(agentId);
  if (!match) return null;
  const [, kind, name] = match;
  try {
    if (kind === "person") {
      const stub = env.PERSON_AGENT.get(env.PERSON_AGENT.idFromName(name));
      return await (stub as unknown as { getPublicKey(): Promise<string> }).getPublicKey();
    }
    const stub = env.ORG_AGENT.get(env.ORG_AGENT.idFromName(name));
    return await (stub as unknown as { getPublicKey(): Promise<string> }).getPublicKey();
  } catch {
    return null;
  }
}
