// Attachment storage: downloaded with a size guard, encrypted per handle
// with the same envelope the engine uses for files, stored in R2.
import {
  MAX_ATTACHMENT_BYTES,
  documentAad,
  encryptForPerson,
  sha256Hex,
  type EventAttachment,
  type LinkChecker,
} from "@mano/channels";

export interface FileStore {
  put(key: string, data: Uint8Array): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  // Keys under the prefix uploaded before the cutoff, oldest first.
  listOlderThan(prefix: string, beforeMs: number, limit: number): Promise<string[]>;
  deleteKeys(keys: string[]): Promise<number>;
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

export interface AttachmentFetchOptions {
  fetchFn: typeof fetch;
  checker: LinkChecker;
  mediaHosts: string[];
  maxBytes?: number;
  maxHops?: number;
}

// Downloads one attachment. Every URL must be https on the provider's
// media hosts, and every redirect hop is checked the same way before it
// is followed. Anything else is refused, never fetched.
export async function fetchAttachment(
  attachment: EventAttachment,
  opts: AttachmentFetchOptions,
): Promise<{ bytes: Uint8Array } | { bytes: null; reason: "oversize" | "host" | "blocked" | "fetch" }> {
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const maxHops = opts.maxHops ?? 5;
  if (typeof attachment.size === "number" && attachment.size > maxBytes) return { bytes: null, reason: "oversize" };
  const allowed = new Set(opts.mediaHosts.map((h) => h.toLowerCase()));
  let url = attachment.url;
  for (let hop = 0; hop <= maxHops; hop++) {
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return { bytes: null, reason: "host" };
      host = parsed.hostname.toLowerCase();
    } catch {
      return { bytes: null, reason: "host" };
    }
    if (!allowed.has(host)) return { bytes: null, reason: "host" };
    const check = await opts.checker.checkHost(host, false);
    if (!check.ok) return { bytes: null, reason: "blocked" };
    const res = await opts.fetchFn(url, { signal: AbortSignal.timeout(30000), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next || hop === maxHops) return { bytes: null, reason: "fetch" };
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok || !res.body) return { bytes: null, reason: "fetch" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { bytes: null, reason: "oversize" };
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return { bytes: out };
  }
  return { bytes: null, reason: "fetch" };
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

  async listOlderThan(prefix: string, beforeMs: number, limit: number): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const listed = await this.bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        if (obj.uploaded.getTime() < beforeMs) keys.push(obj.key);
        if (keys.length >= limit) return keys;
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    return keys;
  }

  async deleteKeys(keys: string[]): Promise<number> {
    await this.bucket.delete(keys);
    return keys.length;
  }
}

export class MemoryFileStore implements FileStore {
  files = new Map<string, Uint8Array>();
  private uploadedAt = new Map<string, number>();

  async put(key: string, data: Uint8Array, atMs: number = Date.now()): Promise<void> {
    this.files.set(key, data);
    this.uploadedAt.set(key, atMs);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) {
        this.files.delete(key);
        this.uploadedAt.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async listOlderThan(prefix: string, beforeMs: number, limit: number): Promise<string[]> {
    const keys: string[] = [];
    for (const [key, at] of [...this.uploadedAt.entries()].sort((a, b) => a[1] - b[1])) {
      if (key.startsWith(prefix) && at < beforeMs) keys.push(key);
      if (keys.length >= limit) break;
    }
    return keys;
  }

  async deleteKeys(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.files.delete(key)) deleted += 1;
      this.uploadedAt.delete(key);
    }
    return deleted;
  }
}
