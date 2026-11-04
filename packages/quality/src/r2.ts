// Signed reads from the private R2 bucket. The staff page runs server-side and
// signs its own GETs with SigV4; the bucket stays fully private, with no
// public prefix and no URL that works unsigned.

import { createHash, createHmac } from "node:crypto";

export const PRIVATE_BUCKET = "mano-quality-private";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface R2Creds {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket?: string;
  region?: string;
}

export interface SignedGet {
  url: string;
  headers: Record<string, string>;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Signs an S3 request over the given header set. Extra headers exist for the
// cross-check test; production signs host, content hash, and date only.
export function signS3(opts: {
  method: "GET" | "PUT";
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  host: string;
  path: string;
  date: Date;
  payloadSha256: string;
  extraHeaders?: Record<string, string>;
}): { authorization: string; amzDate: string } {
  const stamp = amzDate(opts.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    host: opts.host,
    "x-amz-content-sha256": opts.payloadSha256,
    "x-amz-date": stamp,
    ...(opts.extraHeaders ?? {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const canonicalRequest = [opts.method, opts.path, "", canonicalHeaders, names.join(";"), opts.payloadSha256].join("\n");
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");
  const signature = hmac(signingKey(opts.secretAccessKey, day, opts.region), stringToSign).toString("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    amzDate: stamp,
  };
}

export function signS3Get(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  host: string;
  path: string;
  date: Date;
  extraHeaders?: Record<string, string>;
}): { authorization: string; amzDate: string } {
  return signS3({ ...opts, method: "GET", payloadSha256: EMPTY_SHA256 });
}

export function privateObjectUrl(creds: R2Creds, key: string): string {
  const clean = key.replace(/^\/+/, "");
  const encoded = clean.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucket ?? PRIVATE_BUCKET}/${encoded}`;
}

export function signedPrivateGet(creds: R2Creds, key: string, date = new Date()): SignedGet {
  const url = privateObjectUrl(creds, key);
  const host = new URL(url).host;
  const { authorization, amzDate: stamp } = signS3Get({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region ?? "auto",
    host,
    path: new URL(url).pathname,
    date,
  });
  return {
    url,
    headers: {
      authorization,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": stamp,
    },
  };
}

// The account comes from R2_ACCOUNT_ID, or from the host of R2_ENDPOINT
// (https://<account>.r2.cloudflarestorage.com), whichever is set.
export function r2CredsFromEnv(env: NodeJS.ProcessEnv = process.env): R2Creds | null {
  let accountId = env.R2_ACCOUNT_ID ?? "";
  if (!accountId && env.R2_ENDPOINT) {
    try {
      accountId = new URL(env.R2_ENDPOINT).host.split(".")[0] ?? "";
    } catch {
      accountId = "";
    }
  }
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey };
}

// Aggregates (latest, history, baseline) live here; per-case data never does.
export const PUBLIC_BUCKET = "mano-quality";

function signedRequest(creds: R2Creds, bucket: string, key: string, method: "GET" | "PUT", body: Buffer | null, date: Date): SignedGet {
  const url = privateObjectUrl({ ...creds, bucket }, key);
  const parsed = new URL(url);
  const payloadSha256 = body ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256;
  const { authorization, amzDate: stamp } = signS3({
    method,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: creds.region ?? "auto",
    host: parsed.host,
    path: parsed.pathname,
    date,
    payloadSha256,
  });
  return { url, headers: { authorization, "x-amz-content-sha256": payloadSha256, "x-amz-date": stamp } };
}

// Reads one JSON object. A missing object is null; any other failure throws
// with the status only.
export async function r2GetJson<T>(creds: R2Creds, bucket: string, key: string, fetchFn: typeof fetch = fetch): Promise<T | null> {
  const signed = signedRequest(creds, bucket, key, "GET", null, new Date());
  const res = await fetchFn(signed.url, { headers: signed.headers, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 read ${bucket}/${key} failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function r2Put(creds: R2Creds, bucket: string, key: string, body: Buffer, contentType: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const signed = signedRequest(creds, bucket, key, "PUT", body, new Date());
  const res = await fetchFn(signed.url, { method: "PUT", headers: { ...signed.headers, "content-type": contentType }, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`R2 write ${bucket}/${key} failed: ${res.status}`);
}
