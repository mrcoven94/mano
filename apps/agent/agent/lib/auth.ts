// Shared-secret auth between Channels and the agent. Both directions
// carry an HMAC-SHA256 over the exact raw body bytes, hex encoded in
// the x-mano-signature header with a unix-seconds timestamp in
// x-mano-timestamp. Replays outside the window are rejected.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-mano-signature";
export const TIMESTAMP_HEADER = "x-mano-timestamp";
export const MAX_SKEW_SECONDS = 300;

export function signBody(secret: string, timestampSeconds: number, rawBody: Uint8Array | string): string {
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody);
  return createHmac("sha256", secret).update(String(timestampSeconds)).update(".").update(body).digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  reason?: "missing" | "bad_timestamp" | "stale" | "bad_signature";
}

export function verifyRequest(
  secret: string | undefined,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: Uint8Array,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secret || !timestampHeader || !signatureHeader) return { ok: false, reason: "missing" };
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  const expected = signBody(secret, timestamp, rawBody);
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(signatureHeader, "hex");
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
