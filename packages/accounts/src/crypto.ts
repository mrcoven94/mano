// Small crypto helpers. Runtime agnostic: uses WebCrypto only.
// Lookup hashes are HMAC-SHA256 with a pepper and domain.
// Stored values are AES-GCM with a KEK. Neither raw values nor keys are logged.

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function keyedHash(value: string, pepper: string, domain: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${domain}:${value}`));
  return bytesToHex(new Uint8Array(sig));
}

export function lookupDomain(kind: "phone" | "email" | "workos"): string {
  return `mano-identity:${kind}:v1`;
}

export function codeHashDomain(): string {
  return "mano-phone-code:v1";
}

async function importKek(kekB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(kekB64) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptValue(plain: string, kekB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await importKek(kekB64),
    new TextEncoder().encode(plain),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return bytesToBase64(out);
}

export async function decryptValue(sealedB64: string, kekB64: string): Promise<string> {
  const raw = base64ToBytes(sealedB64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await importKek(kekB64),
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

export function randomCode6(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

export function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === "function") return `${prefix}_${crypto.randomUUID()}`;
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${bytesToHex(b)}`;
}
