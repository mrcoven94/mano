// Page encryption. Same envelope as channels files: a random AES GCM data
// key per page, wrapped by the KEK, with the page id bound as associated
// data so a sealed page cannot be transplanted under another link.

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

export function pageAad(storageId: string): Uint8Array {
  return new TextEncoder().encode(`mano-page:v1:${storageId}`);
}

export interface SealedPage {
  enc: true;
  ciphertextB64: string;
  ivB64: string;
  wrappedDekB64: string;
  dekIvB64: string;
}

async function importKek(kekB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(kekB64) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPage(plaintext: Uint8Array, kekB64: string, storageId: string): Promise<SealedPage> {
  const kek = await importKek(kekB64);
  const aad = pageAad(storageId);
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const dek = await crypto.subtle.importKey("raw", dekRaw as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource },
    dek,
    plaintext as BufferSource,
  );
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: dekIv as BufferSource, additionalData: aad as BufferSource },
    kek,
    dekRaw as BufferSource,
  );
  return {
    enc: true,
    ciphertextB64: bytesToB64(new Uint8Array(ct)),
    ivB64: bytesToB64(iv),
    wrappedDekB64: bytesToB64(new Uint8Array(wrapped)),
    dekIvB64: bytesToB64(dekIv),
  };
}

export async function decryptPage(sealed: SealedPage, kekB64: string, storageId: string): Promise<Uint8Array> {
  const kek = await importKek(kekB64);
  const aad = pageAad(storageId);
  const dekRaw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(sealed.dekIvB64) as BufferSource, additionalData: aad as BufferSource },
    kek,
    b64ToBytes(sealed.wrappedDekB64) as BufferSource,
  );
  const dek = await crypto.subtle.importKey("raw", dekRaw, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(sealed.ivB64) as BufferSource, additionalData: aad as BufferSource },
    dek,
    b64ToBytes(sealed.ciphertextB64) as BufferSource,
  );
  return new Uint8Array(pt);
}
