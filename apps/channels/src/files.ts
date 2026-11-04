// Attachments: downloaded with a size guard and stored in the person's
// Engine documents (DocumentStore), encrypted per person there. FileStore
// is Channels' own bucket, which older turns wrote to; the retention
// sweep and a conversation delete still clear it.
import { MAX_ATTACHMENT_BYTES, sha256Hex, type EventAttachment, type LinkChecker } from "@mano/channels";

export interface DocumentStore {
  // Stores one photo under its ID for the conversation's person. True
  // once stored (again for a retried upload of the same bytes); false
  // when refused, as after a delete moved past the generation.
  put(doc: { id: string; name: string; bytes: Uint8Array; generation: number }): Promise<boolean>;
}

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

// Slug-safe document ID, deterministic per generation, turn and position
// so a replayed turn stores the same document.
export async function attachmentDocumentId(generation: number, turn: number, index: number, url: string): Promise<string> {
  const digest = await sha256Hex(url);
  return `g${generation}t${turn}i${index}-${digest.slice(0, 12)}`;
}

// Read from the bytes' own signature, never from what the provider
// claims. Null for anything else (video), which keeps its label.
export function sniffMediaType(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "caff") return "audio/x-caf";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "M4A ") return "audio/mp4";
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"].includes(brand)) return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
  }
  return null;
}

// The sandbox portal takes only PDF, PNG and JPEG. A photo in one of these
// formats is stored as a JPEG copy instead of the original.
const TO_JPEG = new Set(["image/heic", "image/heif", "image/webp"]);

// The type without parameters: a label can carry the file's name.
function bareType(label: string): string {
  return label.split(";")[0]!.trim().toLowerCase();
}

// A voice note, which Mano listens to instead of reading.
export function isVoiceNote(mimeType: string): boolean {
  return bareType(mimeType).startsWith("audio/");
}

export interface PhotoConverter {
  toJpeg(bytes: Uint8Array): Promise<Uint8Array>;
}

// Cloudflare Images, so the decode runs outside the Worker: a 12 MP
// HEIC decoded in the isolate needs more than its 128 MB.
export function imagesConverter(images: ImagesBinding): PhotoConverter {
  return {
    async toJpeg(bytes) {
      const out = await images
        .input(new Blob([bytes as BufferSource]).stream())
        .transform({ width: 4096, height: 4096, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 85 });
      return new Uint8Array(await out.response().arrayBuffer());
    },
  };
}

export interface StoredForm {
  bytes: Uint8Array;
  mimeType: string;
  converted: boolean;
  // Why a photo no office takes was kept as sent. Mail can still read it.
  unconverted?: "no_converter" | "failed" | "too_large";
}

// The only media types Channels passes on, stores or logs. It holds every
// type Mail reads (packages/mail/src/media.ts); a test fails when Mail
// accepts a type this set does not.
export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif", "application/pdf",
  "video/mp4", "video/quicktime", "video/3gpp", "video/webm", "video/mpeg", "audio/mp4", "audio/x-m4a", "audio/mpeg",
  "audio/x-caf", "audio/aac", "audio/ogg", "audio/wav",
  "application/octet-stream",
]);

// A media type fit for a log line: one of a fixed set, else "other".
export function loggableType(label: string | null | undefined): string {
  if (!label) return "none";
  const bare = bareType(label);
  return KNOWN_TYPES.has(bare) ? bare : "other";
}

// What to store for one downloaded file, and as what media type.
export async function storedForm(
  bytes: Uint8Array,
  label: string,
  converter: PhotoConverter | null,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<StoredForm> {
  // A label outside the known set (it can carry anything, a name
  // included) becomes the generic type before it is stored or passed on.
  const labeled = bareType(label);
  const mimeType = sniffMediaType(bytes) ?? (KNOWN_TYPES.has(labeled) ? labeled : "application/octet-stream");
  if (!TO_JPEG.has(mimeType)) return { bytes, mimeType, converted: false };
  if (!converter) return { bytes, mimeType, converted: false, unconverted: "no_converter" };
  let jpeg: Uint8Array;
  try {
    jpeg = await converter.toJpeg(bytes);
  } catch {
    return { bytes, mimeType, converted: false, unconverted: "failed" };
  }
  if (sniffMediaType(jpeg) !== "image/jpeg") return { bytes, mimeType, converted: false, unconverted: "failed" };
  if (jpeg.byteLength > maxBytes) return { bytes, mimeType, converted: false, unconverted: "too_large" };
  return { bytes: jpeg, mimeType: "image/jpeg", converted: true };
}

// The bytes for the form a replayed turn chose before: the file as sent,
// or its JPEG copy made again (Images returns the same bytes for the same
// file). Null when the copy cannot be made again: storing the original
// instead would leave one file as two documents.
export async function storedAgain(bytes: Uint8Array, choice: { converted: boolean }, converter: PhotoConverter | null): Promise<Uint8Array | null> {
  if (!choice.converted) return bytes;
  const again = await storedForm(bytes, "", converter);
  return again.converted ? again.bytes : null;
}

export interface AttachmentFetchOptions {
  fetchFn: typeof fetch;
  checker: LinkChecker;
  mediaHosts: string[];
  maxBytes?: number;
  maxHops?: number;
  // Cancels the download (STOP, a delete, a decoration timeout).
  signal?: AbortSignal;
}

// Downloads one attachment. Every URL must be https on the provider's
// media hosts, and every redirect hop is checked the same way before it
// is followed. Anything else is refused, never fetched.
export async function fetchAttachment(
  attachment: EventAttachment,
  opts: AttachmentFetchOptions,
): Promise<{ bytes: Uint8Array; contentType: string } | { bytes: null; reason: "oversize" | "host" | "blocked" | "fetch" }> {
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
    const timeout = AbortSignal.timeout(30000);
    const res = await opts.fetchFn(url, { signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout, redirect: "manual" });
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
    return { bytes: out, contentType: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
  }
  return { bytes: null, reason: "fetch" };
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
