import { decryptForPerson, documentAad, encryptForPerson, type EncryptedBlob } from "./crypto.js";
import { sha256Hex } from "./hash.js";

// The one file boundary: encrypted per person, stored in R2, hashed.
// Approvals resolve document bytes through here, never from the caller.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function documentR2Key(personId: string, documentId: string): string {
  if (!ID_PATTERN.test(personId) || !ID_PATTERN.test(documentId)) {
    throw new Error("Person and document IDs must be slug-safe.");
  }
  return `persons/${personId}/docs/${documentId}`;
}

function requireKek(kekB64: string | undefined): asserts kekB64 is string {
  if (!kekB64) throw new Error("ENCRYPTION_KEK_B64 is not set; document storage is unavailable.");
}

export async function putDocument(
  files: R2Bucket,
  kekB64: string,
  personId: string,
  documentId: string,
  content: Uint8Array,
): Promise<{ hash: string; r2Key: string }> {
  requireKek(kekB64);
  const blob = await encryptForPerson(content, kekB64, documentAad(personId, documentId));
  const r2Key = documentR2Key(personId, documentId);
  await files.put(r2Key, JSON.stringify(blob));
  return { hash: await sha256Hex(content), r2Key };
}

export async function getDocumentBytes(
  files: R2Bucket,
  kekB64: string,
  personId: string,
  documentId: string,
): Promise<Uint8Array | null> {
  requireKek(kekB64);
  const obj = await files.get(documentR2Key(personId, documentId));
  if (!obj) return null;
  const blob = JSON.parse(await obj.text()) as EncryptedBlob;
  return decryptForPerson(blob, kekB64, documentAad(personId, documentId));
}
