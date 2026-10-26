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

export async function encryptForPerson(
  plaintext: Uint8Array,
  kekB64: string,
): Promise<EncryptedBlob> {
  const kek = await importKek(kekB64);
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const dek = await crypto.subtle.importKey("raw", dekRaw as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, dek, plaintext as BufferSource);
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: dekIv as BufferSource },
    kek,
    dekRaw as BufferSource,
  );
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
): Promise<Uint8Array> {
  const kek = await importKek(kekB64);
  const dekRaw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(blob.dekIvB64) as BufferSource },
    kek,
    b64ToBytes(blob.wrappedDekB64) as BufferSource,
  );
  const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(blob.ivB64) as BufferSource },
    dek,
    b64ToBytes(blob.ciphertextB64) as BufferSource,
  );
  return new Uint8Array(pt);
}
