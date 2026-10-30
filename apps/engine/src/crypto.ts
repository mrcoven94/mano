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

// Binds a ciphertext to one person's one document. Decryption with any
// other person or document ID fails authentication.
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
  const dek = await crypto.subtle.importKey("raw", dekRaw as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = (ivBytes: Uint8Array): SubtleCryptoEncryptAlgorithm => ({
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
  const params = (ivBytes: Uint8Array): SubtleCryptoEncryptAlgorithm => ({
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

// The profile's field cipher (src/profile.ts): each value sealed with the
// person's key and bound to the person and the field path, so a sealed
// value cannot be read under another person or moved to another field.
export function profileCipher(kekB64: string, personId: string): { seal(path: string, plaintext: string): Promise<string>; open(path: string, sealed: string): Promise<string> } {
  const aad = (path: string) => new TextEncoder().encode(`mano-profile:v1:${personId}:${path}`);
  return {
    seal: async (path, plaintext) => JSON.stringify(await encryptForPerson(new TextEncoder().encode(plaintext), kekB64, aad(path))),
    open: async (path, sealed) =>
      new TextDecoder().decode(await decryptForPerson(JSON.parse(sealed) as EncryptedBlob, kekB64, aad(path))),
  };
}
