import { decryptForPerson, documentAad, encryptForPerson, type EncryptedBlob } from "./crypto.js";
import { sha256Hex } from "./hash.js";

// The one file boundary: encrypted per person, stored in R2, hashed.
// Approvals resolve document bytes through here, never from the caller.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function documentsPrefix(personId: string): string {
  if (!ID_PATTERN.test(personId)) throw new Error("Person and document IDs must be slug-safe.");
  return `persons/${personId}/docs/`;
}

// A document stored with its conversation generation lives under that
// generation and its content hash, so a delete clears older generations
// by prefix and two uploads of different bytes never share a key. Without
// a generation, the older flat key.
export function documentR2Key(personId: string, documentId: string, generation?: number, hash?: string): string {
  if (!ID_PATTERN.test(documentId)) throw new Error("Person and document IDs must be slug-safe.");
  const prefix = documentsPrefix(personId);
  if (generation === undefined || hash === undefined) return `${prefix}${documentId}`;
  return `${prefix}g${generation}/${documentId}.${hash.slice(0, 16)}`;
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
  generation?: number,
): Promise<{ hash: string; r2Key: string }> {
  requireKek(kekB64);
  const hash = await sha256Hex(content);
  const blob = await encryptForPerson(content, kekB64, documentAad(personId, documentId));
  const r2Key = documentR2Key(personId, documentId, generation, hash);
  await files.put(r2Key, JSON.stringify(blob));
  return { hash, r2Key };
}

export async function getDocumentBytes(
  files: R2Bucket,
  kekB64: string,
  personId: string,
  documentId: string,
  r2Key?: string,
): Promise<Uint8Array | null> {
  requireKek(kekB64);
  const obj = await files.get(r2Key ?? documentR2Key(personId, documentId));
  if (!obj) return null;
  const blob = JSON.parse(await obj.text()) as EncryptedBlob;
  return decryptForPerson(blob, kekB64, documentAad(personId, documentId));
}

// Deletes every stored file of the person except those under a
// generation at or past keepFrom: what a conversation delete leaves
// behind, including an upload that landed during it. Safe to repeat.
export async function sweepDocuments(files: R2Bucket, personId: string, keepFrom: number): Promise<number> {
  const prefix = documentsPrefix(personId);
  let deleted = 0;
  let cursor: string | undefined;
  for (;;) {
    const listed = await files.list({ prefix, cursor });
    const gone = listed.objects
      .map((o) => o.key)
      .filter((key) => {
        const m = key.slice(prefix.length).match(/^g(\d+)\//);
        return !m || Number(m[1]) < keepFrom;
      });
    if (gone.length > 0) await files.delete(gone);
    deleted += gone.length;
    if (!listed.truncated) return deleted;
    cursor = listed.cursor;
  }
}
