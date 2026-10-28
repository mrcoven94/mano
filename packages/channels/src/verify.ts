// Webhook signature checks. Follows the provider's signing guide exactly:
// HMAC-SHA256 over "<timestamp>.<raw body>", constant-time compare, and a
// 5 minute replay window.

export const SIGNATURE_WINDOW_SECONDS = 300;

export type SignatureFailure =
  | "missing_header"
  | "bad_format"
  | "stale"
  | "future"
  | "mismatch";

export interface SignatureCheck {
  ok: boolean;
  failure?: SignatureFailure;
  ageSeconds?: number;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(header: string): { t: string; v1: string } | null {
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("t=")) t = trimmed.slice(2);
    else if (trimmed.startsWith("v1=")) v1 = trimmed.slice(3);
  }
  if (!t || !v1 || !/^[0-9]+$/.test(t) || !/^[0-9a-fA-F]+$/.test(v1)) return null;
  return { t, v1: v1.toLowerCase() };
}

function signedBytes(t: string, rawBody: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(`${t}.`);
  const body = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

export async function computeSignatureHex(secret: string, t: string, rawBody: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, signedBytes(t, rawBody));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySignature(
  rawBody: string | Uint8Array,
  header: string | null,
  secret: string,
  nowSeconds: number,
): Promise<SignatureCheck> {
  if (!header) return { ok: false, failure: "missing_header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, failure: "bad_format" };
  const age = nowSeconds - Number(parsed.t);
  if (age > SIGNATURE_WINDOW_SECONDS) return { ok: false, failure: "stale", ageSeconds: age };
  if (age < -SIGNATURE_WINDOW_SECONDS) return { ok: false, failure: "future", ageSeconds: age };
  const expected = await computeSignatureHex(secret, parsed.t, rawBody);
  if (!timingSafeEqualHex(parsed.v1, expected)) return { ok: false, failure: "mismatch", ageSeconds: age };
  return { ok: true, ageSeconds: age };
}
