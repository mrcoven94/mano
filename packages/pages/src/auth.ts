// HMAC auth for page creation. Same wire construction as the channels
// webhook check: HMAC SHA256 over "<unix seconds>.<raw body>", sent as
// "t=<seconds>,v1=<hex>", with a 5 minute window. Callers reuse the same
// signing code on their side.

export const PAGES_SIGNATURE_WINDOW_SECONDS = 300;

export type PagesAuthFailure = "missing_secret" | "missing_header" | "bad_format" | "stale" | "future" | "mismatch";

export interface PagesAuthCheck {
  ok: boolean;
  failure?: PagesAuthFailure;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseHeader(header: string): { t: string; v1: string } | null {
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

export async function signPagesBody(secret: string, tSeconds: number, rawBody: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${Math.floor(tSeconds)}.`);
  const body = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const sig = await crypto.subtle.sign("HMAC", key, signed as BufferSource);
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${Math.floor(tSeconds)},v1=${hex}`;
}

export async function verifyPagesRequest(
  rawBody: string | Uint8Array,
  header: string | null,
  secret: string,
  nowSeconds: number,
): Promise<PagesAuthCheck> {
  if (!secret) return { ok: false, failure: "missing_secret" };
  if (!header) return { ok: false, failure: "missing_header" };
  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, failure: "bad_format" };
  const age = nowSeconds - Number(parsed.t);
  if (age > PAGES_SIGNATURE_WINDOW_SECONDS) return { ok: false, failure: "stale" };
  if (age < -PAGES_SIGNATURE_WINDOW_SECONDS) return { ok: false, failure: "future" };
  const expected = await signPagesBody(secret, Number(parsed.t), rawBody);
  const expectedV1 = expected.split("v1=")[1] ?? "";
  if (!timingSafeEqualHex(parsed.v1, expectedV1)) return { ok: false, failure: "mismatch" };
  return { ok: true };
}
