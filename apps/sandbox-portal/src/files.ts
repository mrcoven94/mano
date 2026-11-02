/** File bytes live in R2. SQLite holds metadata only, so a 5 MB upload fits. */

export interface FileBytes {
  data: Uint8Array;
  type: string;
}

export interface FileStore {
  put(key: string, data: Uint8Array, type: string): Promise<void>;
  get(key: string): Promise<FileBytes | null>;
  del(keys: string[]): Promise<void>;
}

/** Draft bytes for a session that has not submitted yet. */
export function draftFileKey(sessionId: string, index: number, sha256: string): string {
  return `drafts/${sessionId}/${index}-${sha256}`;
}

/**
 * Filed bytes. The full content hash means two different packets under one
 * key never share an object: a losing racer cannot clobber the winner's bytes.
 */
export function submissionFileKey(scope: string, key: string, index: number, sha256: string): string {
  return `submissions/${scope}/${key}/${index}-${sha256}`;
}

/**
 * One submit attempt's private staging. The attempt id is fresh per request,
 * so a rejected attempt only ever deletes objects it created itself.
 */
export function stagingAttemptKey(attemptId: string, index: number, sha256: string): string {
  return `staging/${attemptId}/${index}-${sha256}`;
}

/**
 * Which row guards a tracked object. The sweep reads the owner back out of
 * the key: every writer namespaces its keys, so the key alone says who can
 * still need the bytes. Anything unrecognized is attempt staging, the oldest
 * tracked kind, which age alone guards.
 */
export type TrackedOwner =
  | { kind: "attempt" }
  | { kind: "session"; sessionId: string }
  | { kind: "submission"; scope: string; key: string };

export function trackedOwner(r2key: string): TrackedOwner {
  const draft = /^drafts\/([^/]+)\//.exec(r2key);
  if (draft?.[1]) return { kind: "session", sessionId: draft[1] };
  if (r2key.startsWith("submissions/")) {
    // submissions/<scope>/<key>/<index>-<sha256>; the key itself may hold slashes.
    const rest = r2key.slice("submissions/".length).split("/");
    if (rest.length >= 3) {
      const scope = rest[0]!;
      const key = rest.slice(1, -1).join("/");
      if (scope && key) return { kind: "submission", scope, key };
    }
  }
  return { kind: "attempt" };
}

/** Minimal R2 surface, so app code never imports cloudflare:workers. */
export interface R2ObjectLike {
  readonly httpMetadata?: { contentType?: string };
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string, options?: unknown): Promise<R2ObjectLike | null>;
  delete(keys: string[]): Promise<void>;
}

export class R2FileStore implements FileStore {
  private bucket: R2BucketLike;

  constructor(bucket: R2BucketLike) {
    this.bucket = bucket;
  }

  async put(key: string, data: Uint8Array, type: string): Promise<void> {
    await this.bucket.put(key, data, { httpMetadata: { contentType: type } });
  }

  async get(key: string): Promise<FileBytes | null> {
    const object = await this.bucket.get(key);
    if (!object?.arrayBuffer) return null;
    return { data: new Uint8Array(await object.arrayBuffer()), type: object.httpMetadata?.contentType ?? "application/octet-stream" };
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.bucket.delete(keys);
  }
}
