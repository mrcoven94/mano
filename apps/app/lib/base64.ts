// Tiny base64 helpers with no dependencies. Hermes, browsers and node all
// run this file unchanged, so the API client and the offline queue share it.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : "=";
    out += i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/\s/g, "");
  if (clean.length % 4 !== 0) throw new Error("Invalid base64 length.");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const v = (ch: string): number => {
      if (ch === "=") return 0;
      const idx = ALPHABET.indexOf(ch);
      if (idx < 0) throw new Error("Invalid base64 character.");
      return idx;
    };
    const a = v(clean[i] ?? "");
    const b = v(clean[i + 1] ?? "");
    const c = v(clean[i + 2] ?? "");
    const d = v(clean[i + 3] ?? "");
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out.push((n >> 16) & 255);
    if (clean[i + 2] !== "=") out.push((n >> 8) & 255);
    if (clean[i + 3] !== "=") out.push(n & 255);
  }
  return new Uint8Array(out);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8ToBytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function utf8ToB64(s: string): string {
  return b64encode(utf8ToBytes(s));
}

export function b64ToUtf8(s: string): string {
  return bytesToUtf8(b64decode(s));
}
