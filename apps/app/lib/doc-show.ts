// Whether a document can be shown in full, in the app, on this
// platform. Text and images render everywhere; PDFs render on web and
// iOS but not in the Android webview. Anything else, including unknown
// bytes, is not shown, and the approval screen keeps Approve disabled.
//
// The engine serves every file as octet-stream, so unknown types are
// sniffed from magic bytes, never trusted from the name.

import { b64decode } from "./base64";

export type DocPlatform = "web" | "ios" | "android";

function magic(bytes: Uint8Array): string {
  const head = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (head.startsWith("89504e47")) return "image/png";
  if (head.startsWith("ffd8ff")) return "image/jpeg";
  if (head.startsWith("25504446")) return "application/pdf";
  if (head.startsWith("47494638")) return "image/gif";
  return "";
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 2000);
  if (sample.length === 0) return false;
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable += 1;
  }
  return printable / sample.length > 0.95;
}

export function sniffMime(mimeType: string, bytesB64: string): string {
  if (mimeType !== "application/octet-stream") return mimeType;
  const bytes = b64decode(bytesB64);
  return magic(bytes) || (looksLikeText(bytes) ? "text/plain" : "application/octet-stream");
}

// canShowInApp for bytes that may not decode: undecodable input is
// unviewable, never a crash.
export function canShowBytes(mimeType: string, bytesB64: string, platform: DocPlatform): boolean {
  try {
    return canShowInApp(sniffMime(mimeType, bytesB64), platform);
  } catch {
    return false;
  }
}

export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

// Viewer navigation policy: only the document itself, its own page
// jumps and the blank page may load inside the viewer. Anything else
// is a link to check before it opens anywhere.
export function navigationAllowed(url: string, docUri: string): boolean {
  return url === docUri || url === "about:blank" || url.startsWith(`${docUri}#`);
}

export function canShowInApp(mime: string, platform: DocPlatform): boolean {
  if (mime.startsWith("image/") || mime.startsWith("text/")) return true;
  if (mime === "application/pdf") return platform !== "android";
  return false;
}
