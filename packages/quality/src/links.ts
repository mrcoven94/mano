// Link checking. Every link in an answer is resolved with DNS-over-HTTPS
// (security filter, plus the family filter for anything shown to a person).
// 0.0.0.0 means blocked; a lookup error also blocks. The local client answers
// from fixture verdicts so the bench stays deterministic; the live client uses
// real DNS for every host except .example, which is synthetic by definition.

import { FIXTURE_STATES, SCAM_HOSTS } from "./facts.ts";

export type DnsMode = "local" | "live";

export interface DnsAnswer {
  addresses: string[];
}

export interface DnsClient {
  mode: DnsMode;
  resolveA(host: string): Promise<DnsAnswer>;
}

export interface LinkVerdict {
  url: string;
  host: string;
  pass: boolean;
  reason: string;
}

function fixtureHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const s of FIXTURE_STATES) {
    for (const p of s.programs) hosts.add(new URL(p.url).host.toLowerCase());
  }
  return hosts;
}

export class LocalDns implements DnsClient {
  readonly mode: DnsMode = "local";
  private ok: Set<string>;
  private blocked: Set<string>;

  constructor() {
    this.ok = fixtureHosts();
    this.blocked = new Set(SCAM_HOSTS.map((h) => h.toLowerCase()));
  }

  async resolveA(host: string): Promise<DnsAnswer> {
    const h = host.toLowerCase();
    if (this.blocked.has(h)) return { addresses: ["0.0.0.0"] };
    if (this.ok.has(h)) return { addresses: ["192.0.2.1"] };
    throw new Error(`local DNS knows no verdict for ${host}`);
  }
}

interface DohJson {
  Answer?: { type: number; data: string }[];
}

export class DohDns implements DnsClient {
  readonly mode: DnsMode = "live";
  private securityUrl: string;
  private familyUrl: string;
  private local = new LocalDns();

  constructor(
    securityUrl = "https://security.cloudflare-dns.com/dns-query",
    familyUrl = "https://family.cloudflare-dns.com/dns-query",
  ) {
    this.securityUrl = securityUrl;
    this.familyUrl = familyUrl;
  }

  async resolveA(host: string): Promise<DnsAnswer> {
    // Synthetic fixture hosts cannot resolve in real DNS; answer locally.
    if (host.toLowerCase().endsWith(".example")) return this.local.resolveA(host);
    // Both resolvers must answer successfully. One error or one empty answer
    // fails the lookup, and the link check fails closed on any lookup failure.
    const [security, family] = await Promise.allSettled([
      this.query(this.securityUrl, host),
      this.query(this.familyUrl, host),
    ]);
    const answers: string[][] = [];
    for (const [name, settled] of [["security", security], ["family", family]] as const) {
      if (settled.status !== "fulfilled") throw new Error(`DNS ${name} resolver failed for ${host}`);
      if (settled.value.length === 0) throw new Error(`DNS ${name} resolver returned no answer for ${host}`);
      answers.push(settled.value);
    }
    return { addresses: answers.flat() };
  }

  private async query(base: string, host: string): Promise<string[]> {
    const res = await fetch(`${base}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    if (!res.ok) throw new Error(`DNS lookup failed for ${host}: ${res.status}`);
    const body = (await res.json()) as DohJson;
    return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  }
}

// Live runs (a model key is set) check links against the Cloudflare
// resolvers by default; MANO_QUALITY_LIVE_DNS=0 forces the local table and
// =1 forces DoH without a key.
export function dnsFromEnv(env: NodeJS.ProcessEnv = process.env): DnsClient {
  const forced = env.MANO_QUALITY_LIVE_DNS;
  if (forced === "1" || (forced !== "0" && Boolean(env.META_MODEL_API_KEY))) {
    return new DohDns(env.MANO_QUALITY_DNS_URL || undefined, env.MANO_QUALITY_DNS_FAMILY_URL || undefined);
  }
  return new LocalDns();
}

export async function checkLink(rawUrl: string, dns: DnsClient): Promise<LinkVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, host: "", pass: false, reason: "not a URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: rawUrl, host: parsed.host, pass: false, reason: `scheme ${parsed.protocol} is not allowed` };
  }
  try {
    const answer = await dns.resolveA(parsed.host);
    if (answer.addresses.includes("0.0.0.0")) {
      return { url: rawUrl, host: parsed.host, pass: false, reason: "DNS filter blocks this host" };
    }
    return { url: rawUrl, host: parsed.host, pass: true, reason: `DNS ok (${dns.mode})` };
  } catch (err) {
    return { url: rawUrl, host: parsed.host, pass: false, reason: err instanceof Error ? err.message : "DNS lookup failed" };
  }
}
