// Attachment storage: downloaded with a size guard, encrypted per handle
// with the same envelope the engine uses for files, stored in R2.
import {
  MAX_ATTACHMENT_BYTES,
  documentAad,
  encryptForPerson,
  sha256Hex,
  type EventAttachment,
} from "@mano/channels";

export interface FileStore {
  put(key: string, data: Uint8Array): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export function conversationFilePrefix(handleHash: string): string {
  return `persons/${handleHash}/docs/`;
}

// Slug-safe document ID, deterministic per turn and position so a replayed
// turn writes the same keys.
export async function attachmentDocumentId(turn: number, index: number, url: string): Promise<string> {
  const digest = await sha256Hex(url);
  return `t${turn}i${index}-${digest.slice(0, 12)}`;
}

export async function downloadBounded(
  attachment: EventAttachment,
  fetchFn: typeof fetch,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): Promise<Uint8Array | null> {
  if (typeof attachment.size === "number" && attachment.size > maxBytes) return null;
  const res = await fetchFn(attachment.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function saveAttachment(
  files: FileStore,
  kekB64: string,
  handleHash: string,
  documentId: string,
  content: Uint8Array,
): Promise<{ hash: string; r2Key: string }> {
  const blob = await encryptForPerson(content, kekB64, documentAad(handleHash, documentId));
  const r2Key = `${conversationFilePrefix(handleHash)}${documentId}`;
  await files.put(r2Key, new TextEncoder().encode(JSON.stringify(blob)));
  return { hash: await sha256Hex(content), r2Key };
}

export class R2FileStore implements FileStore {
  private bucket: R2Bucket;
  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.bucket.put(key, data as BufferSource);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let cursor: string | undefined;
    for (;;) {
      const listed = await this.bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        await this.bucket.delete(obj.key);
        deleted += 1;
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    return deleted;
  }
}

export class MemoryFileStore implements FileStore {
  files = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    this.files.set(key, data);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) {
        this.files.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}
