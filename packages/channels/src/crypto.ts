// Per-person envelope encryption, the same construction the engine uses
// for files: a random AES-GCM data key per document, wrapped by the KEK,
// with the person and document IDs bound as associated data.

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

async function importKek(kekB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(kekB64) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedBlob {
  ciphertextB64: string;
  ivB64: string;
  wrappedDekB64: string;
  dekIvB64: string;
}

export function documentAad(personId: string, documentId: string): Uint8Array {
  return new TextEncoder().encode(`mano-doc:v1:${personId}:${documentId}`);
}

export async function encryptForPerson(
  plaintext: Uint8Array,
  kekB64: string,
  associatedData?: Uint8Array,
): Promise<EncryptedBlob> {
  const kek = await importKek(kekB64);
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const dek = await crypto.subtle.importKey("raw", dekRaw as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = (ivBytes: Uint8Array) => ({
    name: "AES-GCM",
    iv: ivBytes as BufferSource,
    ...(associatedData ? { additionalData: associatedData as BufferSource } : {}),
  });
  const ct = await crypto.subtle.encrypt(params(iv), dek, plaintext as BufferSource);
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(params(dekIv), kek, dekRaw as BufferSource);
  return {
    ciphertextB64: bytesToB64(new Uint8Array(ct)),
    ivB64: bytesToB64(iv),
    wrappedDekB64: bytesToB64(new Uint8Array(wrapped)),
    dekIvB64: bytesToB64(dekIv),
  };
}

export async function decryptForPerson(
  blob: EncryptedBlob,
  kekB64: string,
  associatedData?: Uint8Array,
): Promise<Uint8Array> {
  const kek = await importKek(kekB64);
  const params = (ivBytes: Uint8Array) => ({
    name: "AES-GCM",
    iv: ivBytes as BufferSource,
    ...(associatedData ? { additionalData: associatedData as BufferSource } : {}),
  });
  const dekRaw = await crypto.subtle.decrypt(
    params(b64ToBytes(blob.dekIvB64)),
    kek,
    b64ToBytes(blob.wrappedDekB64) as BufferSource,
  );
  const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    params(b64ToBytes(blob.ivB64)),
    dek,
    b64ToBytes(blob.ciphertextB64) as BufferSource,
  );
  return new Uint8Array(pt);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
