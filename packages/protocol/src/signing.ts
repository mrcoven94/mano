import type { ProtocolMessage } from "./types.js";

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function canonicalPayload(
  msg: Omit<ProtocolMessage, "signature" | "signerPublicKey">,
): string {
  return JSON.stringify({
    id: msg.id,
    type: msg.type,
    caseId: msg.caseId,
    fromAgentId: msg.fromAgentId,
    toAgentId: msg.toAgentId,
    payload: msg.payload,
    sources: msg.sources,
    approvedByHumanId: msg.approvedByHumanId,
    idempotencyKey: msg.idempotencyKey,
    createdAt: msg.createdAt,
  });
}

export async function generateAgentKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string;
}> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyB64: b64(raw) };
}

export async function signMessage<T>(
  unsigned: Omit<ProtocolMessage<T>, "signature" | "signerPublicKey">,
  privateKey: CryptoKey,
  publicKeyB64: string,
): Promise<ProtocolMessage<T>> {
  const data = new TextEncoder().encode(
    canonicalPayload(unsigned as unknown as Omit<ProtocolMessage, "signature" | "signerPublicKey">),
  );
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data as BufferSource);
  return { ...unsigned, signature: b64(sig), signerPublicKey: publicKeyB64 };
}

// Verifies against a registry key for the sender (resolved by the caller
// from its own agent directory), never against the key inside the message.
// A message carrying a different key than the registry fails closed.
export async function verifyMessage(
  msg: ProtocolMessage,
  expectedPublicKeyB64: string,
): Promise<boolean> {
  try {
    if (msg.signerPublicKey !== expectedPublicKeyB64) return false;
    const { signature, signerPublicKey: _claimed, ...rest } = msg;
    const key = await crypto.subtle.importKey(
      "raw",
      unb64(expectedPublicKeyB64) as BufferSource,
      "Ed25519",
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(canonicalPayload(rest));
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      unb64(signature) as BufferSource,
      data as BufferSource,
    );
  } catch {
    return false;
  }
}

export function validateMessageShape(msg: unknown): msg is ProtocolMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  const types = [
    "case.open",
    "document.request",
    "document.provide",
    "decision",
    "notice",
    "consent.grant",
    "consent.revoke",
  ];
  return (
    typeof m.id === "string" &&
    types.includes(m.type as string) &&
    typeof m.caseId === "string" &&
    typeof m.fromAgentId === "string" &&
    typeof m.toAgentId === "string" &&
    Array.isArray(m.sources) &&
    typeof m.idempotencyKey === "string" &&
    m.idempotencyKey.length > 0 &&
    typeof m.signature === "string" &&
    typeof m.signerPublicKey === "string" &&
    typeof m.createdAt === "string"
  );
}
