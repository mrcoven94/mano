// Tokens are the only key to a page. Each is 128 bits from the platform
// random source, encoded as 22 url safe chars. Storage keys derive from
// the token hash, so a bucket listing never holds a usable link.

export const PAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function tokenStorageId(token: string): Promise<string> {
  return sha256Hex(`mano-page:v1:${token}`);
}
