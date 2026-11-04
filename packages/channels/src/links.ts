// Links are checked before use. Every host resolves over DNS-over-HTTPS:
// an answer of 0.0.0.0 means blocked, and a lookup error also blocks.
import { boundFetch } from "./fetch.js";
// Anything shown to a person checks against both the family and the
// security filters.

export const SECURITY_DOH_BASE = "https://security.cloudflare-dns.com/dns-query";
export const FAMILY_DOH_BASE = "https://family.cloudflare-dns.com/dns-query";

export type LinkBlockReason = "clean" | "blocked" | "lookup_error" | "bad_url";

export interface LinkCheckResult {
  ok: boolean;
  reason: LinkBlockReason;
  host: string;
}

// Anything Messages would render tappable: full URLs in any scheme
// case, www. hosts, and bare domains with a dotted alpha TLD, in any
// script. Numbers (1.2), single-letter trails (Section 4.b) and the
// domain inside an email address, subdomains included, do not match.
const LINK_PATTERN =
  /\bhttps?:\/\/[^\s<>"')\]]+|\b(?<!@)(?:www\.)?(?:[\p{L}0-9](?:[\p{L}0-9-]{0,61}[\p{L}0-9])?\.)+[\p{L}]{2,}(?::\d{1,5})?(?:\/[^\s<>"')\]]*)?/giu;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;
const HOST_CHAR = /[\p{L}0-9.-]/u;
const HOST_RUN = /[\p{L}0-9.-]+/uy;
// The longest host name there is. Past it, a match is treated as a link.
const MAX_HOST_CHARS = 253;

// True when a match without a scheme is the tail of an email address, as
// example.test is in a@inbox.example.test. Checked here rather than with a
// lookbehind in the pattern, which walks back from every candidate and is
// quadratic on a long run of labels.
function inEmailAddress(text: string, start: number): boolean {
  for (let i = start - 1; i >= 0 && start - i <= MAX_HOST_CHARS; i--) {
    const c = text[i]!;
    if (c === "@") return true;
    if (!HOST_CHAR.test(c)) return false;
  }
  return false;
}

function linkMatches(text: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  LINK_PATTERN.lastIndex = 0;
  for (let m = LINK_PATTERN.exec(text); m; m = LINK_PATTERN.exec(text)) {
    if (/^https?:/i.test(m[0]) || !inEmailAddress(text, m.index)) {
      matches.push(m);
      continue;
    }
    // Only the address's host is passed over: a path after it can hold a
    // link of its own.
    HOST_RUN.lastIndex = m.index;
    HOST_RUN.test(text);
    LINK_PATTERN.lastIndex = HOST_RUN.lastIndex;
  }
  return matches;
}

export function extractLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of linkMatches(text)) {
    const cleaned = match[0].replace(TRAILING_PUNCT, "");
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
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.securityBase = (opts.securityBase ?? SECURITY_DOH_BASE).replace(/\/$/, "");
    this.familyBase = (opts.familyBase ?? FAMILY_DOH_BASE).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async checkUrl(url: string, family = false): Promise<LinkCheckResult> {
    let host: string;
    try {
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
      const parsed = new URL(candidate);
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
    // Person-visible hosts clear both filters; either one blocks. Both are
    // asked at once, and the first block in this order is the answer.
    const bases = family ? [this.familyBase, this.securityBase] : [this.securityBase];
    const verdicts = await Promise.all(bases.map((base) => this.lookup(base, normalized)));
    return verdicts.find((v) => !v.ok) ?? { ok: true, reason: "clean", host: normalized };
  }

  private async lookup(base: string, host: string): Promise<LinkCheckResult> {
    try {
      const res = await this.fetchFn(`${base}?name=${encodeURIComponent(host)}&type=A`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) return { ok: false, reason: "lookup_error", host };
      const data = (await res.json().catch(() => null)) as {
        Status?: unknown;
        Answer?: Array<{ data?: unknown }> | unknown;
      } | null;
      if (!data || data.Status !== 0 || !Array.isArray(data.Answer) || data.Answer.length === 0) {
        return { ok: false, reason: "lookup_error", host };
      }
      const blocked = data.Answer.some((a) => typeof a?.data === "string" && a.data.trim() === "0.0.0.0");
      return blocked ? { ok: false, reason: "blocked", host } : { ok: true, reason: "clean", host };
    } catch {
      return { ok: false, reason: "lookup_error", host };
    }
  }
}

export const LINK_REMOVED = "(link removed)";

// Removes blocked links from reply text rather than sending them. Only
// the count is logged; URLs stay out of logs. Every distinct link is
// checked at once. cleared names links this same reply already passed,
// so a second pass over its bubbles looks up only what is new; the
// answer's cleared adds the links this pass passed.
export async function stripBlockedLinks(
  text: string,
  checker: LinkChecker,
  cleared: ReadonlySet<string> = new Set(),
): Promise<{ text: string; removed: number; cleared: Set<string> }> {
  const matches = linkMatches(text).map((m) => ({
    start: m.index ?? 0,
    length: m[0].length,
    cleaned: m[0].replace(TRAILING_PUNCT, ""),
  }));
  const fresh = [...new Set(matches.map((m) => m.cleaned).filter((url) => url && !cleared.has(url)))];
  const verdicts = await Promise.all(fresh.map((url) => checker.checkUrl(url, true)));
  const passed = new Set(cleared);
  fresh.forEach((url, i) => {
    if (verdicts[i].ok) passed.add(url);
  });
  // Replaces each match in place by index. A substring replace would
  // also rewrite the match inside a longer host (evil.test inside
  // xevil.test); index replacement cannot.
  let out = "";
  let last = 0;
  let removed = 0;
  for (const { start, length, cleaned } of matches) {
    out += text.slice(last, start);
    if (!cleaned) {
      last = start + length;
      continue;
    }
    if (passed.has(cleaned)) {
      out += cleaned;
    } else {
      out += LINK_REMOVED;
      removed += 1;
    }
    last = start + cleaned.length;
  }
  out += text.slice(last);
  return { text: out, removed, cleared: passed };
}
