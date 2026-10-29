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

// Signs an S3 GET over the given header set. Extra headers exist for the
// cross-check test; production signs host, content hash, and date only.
export function signS3Get(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  host: string;
  path: string;
  date: Date;
  extraHeaders?: Record<string, string>;
}): { authorization: string; amzDate: string } {
  const stamp = amzDate(opts.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    host: opts.host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": stamp,
    ...(opts.extraHeaders ?? {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const canonicalRequest = [
    "GET",
    opts.path,
    "",
    canonicalHeaders,
    names.join(";"),
    EMPTY_SHA256,
  ].join("\n");
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonicalRequest, "utf8").digest("hex")].join("\n");
  const signature = hmac(signingKey(opts.secretAccessKey, day, opts.region), stringToSign).toString("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    amzDate: stamp,
  };
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

export function r2CredsFromEnv(env: NodeJS.ProcessEnv = process.env): R2Creds | null {
  const accountId = env.R2_ACCOUNT_ID ?? "";
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey };
}
