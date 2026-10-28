// Links are checked before use. Every host resolves over DNS-over-HTTPS:
// an answer of 0.0.0.0 means blocked, and a lookup error also blocks.
// Anything shown to a person checks against the family filter.

export const SECURITY_DOH_BASE = "https://security.cloudflare-dns.com/dns-query";
export const FAMILY_DOH_BASE = "https://family.cloudflare-dns.com/dns-query";

export type LinkBlockReason = "clean" | "blocked" | "lookup_error" | "bad_url";

export interface LinkCheckResult {
  ok: boolean;
  reason: LinkBlockReason;
  host: string;
}

const LINK_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

export function extractLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.match(LINK_PATTERN) ?? []) {
    const cleaned = match.replace(TRAILING_PUNCT, "");
    if (cleaned) found.add(cleaned);
  }
  return [...found];
}

export interface LinkCheckerOptions {
  fetchFn?: typeof fetch;
  securityBase?: string;
  familyBase?: string;
  timeoutMs?: number;
}

export class LinkChecker {
  private fetchFn: typeof fetch;
  private securityBase: string;
  private familyBase: string;
  private timeoutMs: number;

  constructor(opts: LinkCheckerOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.securityBase = (opts.securityBase ?? SECURITY_DOH_BASE).replace(/\/$/, "");
    this.familyBase = (opts.familyBase ?? FAMILY_DOH_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async checkUrl(url: string, family = false): Promise<LinkCheckResult> {
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, reason: "bad_url", host: "" };
      }
      host = parsed.hostname.toLowerCase();
      if (!host) return { ok: false, reason: "bad_url", host: "" };
    } catch {
      return { ok: false, reason: "bad_url", host: "" };
    }
    return this.checkHost(host, family);
  }

  async checkHost(host: string, family = false): Promise<LinkCheckResult> {
    const normalized = host.toLowerCase();
    if (!normalized || normalized.includes(" ")) return { ok: false, reason: "bad_url", host: normalized };
    try {
      const base = family ? this.familyBase : this.securityBase;
      const res = await this.fetchFn(`${base}?name=${encodeURIComponent(normalized)}&type=A`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) return { ok: false, reason: "lookup_error", host: normalized };
      const data = (await res.json().catch(() => null)) as {
        Status?: unknown;
        Answer?: Array<{ data?: unknown }> | unknown;
      } | null;
      if (!data || data.Status !== 0 || !Array.isArray(data.Answer) || data.Answer.length === 0) {
        return { ok: false, reason: "lookup_error", host: normalized };
      }
      const blocked = data.Answer.some((a) => typeof a?.data === "string" && a.data.trim() === "0.0.0.0");
      return blocked
        ? { ok: false, reason: "blocked", host: normalized }
        : { ok: true, reason: "clean", host: normalized };
    } catch {
      return { ok: false, reason: "lookup_error", host: normalized };
    }
  }
}

export const LINK_REMOVED = "(link removed)";

// Removes blocked links from reply text rather than sending them. Only
// the count is logged; URLs stay out of logs.
export async function stripBlockedLinks(
  text: string,
  checker: LinkChecker,
): Promise<{ text: string; removed: number }> {
  let out = text;
  let removed = 0;
  for (const link of extractLinks(text)) {
    const check = await checker.checkUrl(link, true);
    if (!check.ok) {
      out = out.split(link).join(LINK_REMOVED);
      removed += 1;
    }
  }
  return { text: out, removed };
}
