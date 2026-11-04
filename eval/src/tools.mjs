// Shared tools given identically to both baselines.
// Link checking follows AGENTS.md rule 6: resolve via Cloudflare DoH,
// 0.0.0.0 means blocked, lookup error also blocks (fail closed).
const BLOCKED = new Set(["benefits-verify-now.example", "secure-benefits-check.example"]);

export async function checkLink(url, { fetchImpl = fetch } = {}) {
  let host;
  try { host = new URL(url).hostname; } catch { return { allowed: false, reason: "invalid_url" }; }
  if (BLOCKED.has(host)) return { allowed: false, reason: "blocked_domain" };
  try {
    const u = `https://security.cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`;
    const res = await fetchImpl(u, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return { allowed: false, reason: "lookup_error" };
    const data = await res.json();
    const answers = data.Answer || [];
    if (answers.some((a) => a.data === "0.0.0.0")) return { allowed: false, reason: "blocked_0.0.0.0" };
    if (answers.length === 0) return { allowed: false, reason: "no_answer" };
    return { allowed: true, reason: "resolved" };
  } catch {
    return { allowed: false, reason: "lookup_error" };
  }
}
// Offline deterministic variant for tests and keyless runs: no network.
export function checkLinkOffline(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return { allowed: false, reason: "invalid_url" }; }
  if (BLOCKED.has(host)) return { allowed: false, reason: "blocked_domain" };
  if (host.endsWith(".example")) return { allowed: false, reason: "blocked_domain" };
  return { allowed: true, reason: "resolved_offline" };
}
export function extractDates(text) {
  return [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
}
export function findLinks(text) {
  return [...text.matchAll(/https?:\/\/[^\s]+/g)].map((m) => m[0]);
}
