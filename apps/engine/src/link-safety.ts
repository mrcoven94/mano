export interface DohAnswer {
  Answer?: { data: string; type: number }[];
  Status?: number;
}

export type FetchFn = typeof fetch;

export function extractHttpUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  return [...new Set(found.map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

// Replaces every blocked URL in person-visible text. A check error blocks,
// same as a block verdict: fail closed.
export async function redactBlockedLinks(
  text: string,
  check: (url: string) => Promise<{ allowed: boolean }>,
): Promise<{ text: string; blocked: string[] }> {
  const blocked: string[] = [];
  let out = text;
  for (const url of extractHttpUrls(text)) {
    let allowed = false;
    try {
      allowed = (await check(url)).allowed;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      blocked.push(url);
      out = out.split(url).join("[blocked link]");
    }
  }
  return { text: out, blocked };
}

export async function checkLinkSafety(
  url: string,
  opts: { forDisplay?: boolean; fetchFn?: FetchFn } = {},
): Promise<{ allowed: boolean; reason?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "Invalid URL." };
  }
  const endpoints = ["https://security.cloudflare-dns.com/dns-query"];
  if (opts.forDisplay) endpoints.push("https://family.cloudflare-dns.com/dns-query");
  for (const base of endpoints) {
    try {
      const res = await fetchFn(`${base}?name=${encodeURIComponent(host)}&type=A`, {
        headers: { accept: "application/dns-json" },
      });
      if (!res.ok) return { allowed: false, reason: "DNS check failed." };
      const data = (await res.json()) as DohAnswer;
      const answers = data.Answer ?? [];
      if (answers.length === 0) return { allowed: false, reason: "No DNS answer." };
      for (const a of answers) {
        if (a.data === "0.0.0.0") return { allowed: false, reason: "Blocked domain." };
      }
    } catch {
      return { allowed: false, reason: "DNS check error." };
    }
  }
  return { allowed: true };
}
