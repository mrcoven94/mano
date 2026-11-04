import { boundFetch } from "./fetch.js";

export interface DohAnswer {
  Answer?: { data: string; type: number }[];
  Status?: number;
}

export type FetchFn = typeof fetch;

const HTTP_URLS = /https?:\/\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function extractHttpUrls(text: string): string[] {
  const found = text.match(HTTP_URLS) ?? [];
  return [...new Set(found.map((url) => url.replace(TRAILING_PUNCTUATION, "")))];
}

// Replaces every blocked URL in person-visible text. A check error blocks,
// same as a block verdict: fail closed. The checks run together.
export async function redactBlockedLinks(
  text: string,
  check: (url: string) => Promise<{ allowed: boolean }>,
): Promise<{ text: string; blocked: string[] }> {
  const urls = extractHttpUrls(text);
  const allowed = await Promise.all(urls.map((url) => check(url).then((v) => v.allowed, () => false)));
  const blocked = urls.filter((_, i) => !allowed[i]);
  let out = text;
  for (const url of blocked) out = out.split(url).join("[blocked link]");
  return { text: out, blocked };
}

// Why a link was blocked. A closed set, so the reason is safe to audit.
export type LinkBlockReason = "Invalid URL." | "DNS check failed." | "No DNS answer." | "Blocked domain." | "DNS check error.";

export async function checkLinkSafety(
  url: string,
  opts: { forDisplay?: boolean; fetchFn?: FetchFn } = {},
): Promise<{ allowed: boolean; reason?: LinkBlockReason }> {
  const fetchFn = opts.fetchFn ?? boundFetch;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "Invalid URL." };
  }
  const endpoints = ["https://security.cloudflare-dns.com/dns-query"];
  if (opts.forDisplay) endpoints.push("https://family.cloudflare-dns.com/dns-query");
  // Both resolvers are asked at once. Any block wins, and the reason is
  // the first endpoint's, as when they were asked in turn.
  const reasons = await Promise.all(endpoints.map((base) => lookupBlockReason(fetchFn, base, host)));
  const reason = reasons.find((r) => r !== null);
  return reason ? { allowed: false, reason } : { allowed: true };
}

async function lookupBlockReason(fetchFn: FetchFn, base: string, host: string): Promise<LinkBlockReason | null> {
  try {
    const res = await fetchFn(`${base}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return "DNS check failed.";
    }
    const answers = ((await res.json()) as DohAnswer).Answer ?? [];
    if (answers.length === 0) return "No DNS answer.";
    return answers.some((a) => a.data === "0.0.0.0") ? "Blocked domain." : null;
  } catch {
    return "DNS check error.";
  }
}
