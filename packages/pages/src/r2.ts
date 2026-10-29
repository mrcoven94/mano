// R2 storage for pages, over the S3 compatible API with SigV4 signing and
// no new dependencies. R2 is already where the repo keeps files (channels
// attachments, sandbox portal uploads), so pages reuse the same provider
// instead of adding Vercel storage. The site cannot hold a Worker binding,
// so it signs HTTPS calls with the account S3 credentials from env.

import type { PageStore } from "./store.js";

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const DEFAULT_PAGES_BUCKET = "mano-pages";

export function r2ConfigFromEnv(env: Record<string, string | undefined>): R2Config | null {
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket: env.MANO_PAGES_BUCKET || DEFAULT_PAGES_BUCKET, accessKeyId, secretAccessKey };
}

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacBytes(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, bytes as BufferSource));
}

function toAmzDate(ms: number): { amzDate: string; stamp: string } {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const amzDate = `${stamp}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return { amzDate, stamp };
}

export interface SignedS3 {
  url: string;
  headers: Record<string, string>;
}

export async function signS3Request(args: {
  method: string;
  endpoint: string;
  bucket: string;
  key: string;
  payload: Uint8Array | null;
  accessKeyId: string;
  secretAccessKey: string;
  nowMs: number;
}): Promise<SignedS3> {
  const base = args.endpoint.replace(/\/$/, "");
  const path = `/${args.bucket}/${args.key.split("/").map(encodeURIComponent).join("/")}`;
  const url = `${base}${path}`;
  const host = new URL(url).host;
  const { amzDate, stamp } = toAmzDate(args.nowMs);
  const payloadHash = args.payload ? await sha256HexBytes(args.payload) : await sha256HexBytes(new Uint8Array(0));
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${args.method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${stamp}/auto/s3/aws4_request`;
  const canonicalHash = await sha256HexBytes(new TextEncoder().encode(canonicalRequest));
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalHash}`;
  const secret = new TextEncoder().encode(`AWS4${args.secretAccessKey}`);
  const kDate = await hmacBytes(secret, stamp);
  const kRegion = await hmacBytes(kDate, "auto");
  const kService = await hmacBytes(kRegion, "s3");
  const kSigning = await hmacBytes(kService, "aws4_request");
  const signature = [...(await hmacBytes(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    url,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}

export class R2PageStore implements PageStore {
  private config: R2Config;
  private fetchFn: typeof fetch;
  private nowMs: () => number;

  constructor(config: R2Config, fetchFn: typeof fetch = fetch, nowMs: () => number = Date.now) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.nowMs = nowMs;
  }

  private signed(method: string, key: string, payload: Uint8Array | null): Promise<SignedS3> {
    return signS3Request({
      method,
      endpoint: this.config.endpoint,
      bucket: this.config.bucket,
      key,
      payload,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      nowMs: this.nowMs(),
    });
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const { url, headers } = await this.signed("PUT", key, data);
    const res = await this.fetchFn(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/octet-stream" },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`r2 put failed with ${res.status}`);
    await res.arrayBuffer().catch(() => null);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { url, headers } = await this.signed("GET", key, null);
    const res = await this.fetchFn(url, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`r2 get failed with ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = await this.signed("DELETE", key, null);
    const res = await this.fetchFn(url, { method: "DELETE", headers });
    if (!res.ok) throw new Error(`r2 delete failed with ${res.status}`);
    await res.arrayBuffer().catch(() => null);
  }
}
