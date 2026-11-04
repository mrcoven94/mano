import { describe, expect, it, vi } from "vitest";
import { LINK_REMOVED, LinkChecker, extractLinks, stripBlockedLinks } from "../src/links.js";

function dohJson(status: number, answers: Array<{ data: string }>): Response {
  return new Response(JSON.stringify({ Status: status, Answer: answers }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

describe("extractLinks", () => {
  it("finds links and trims trailing punctuation", () => {
    expect(extractLinks("See https://example.test/a, and http://x.test/b.")).toEqual([
      "https://example.test/a",
      "http://x.test/b",
    ]);
    expect(extractLinks("no links here")).toEqual([]);
  });

  it("matches uppercase schemes and bare domains the way Messages links them", () => {
    expect(extractLinks("See HTTPS://EVIL.TEST/trap and evil.test/again plus www.ok.test/x.")).toEqual([
      "HTTPS://EVIL.TEST/trap",
      "evil.test/again",
      "www.ok.test/x",
    ]);
    expect(extractLinks("v1.2 costs 3.14, see Section 4.b, mail david@example.test")).toEqual([]);
  });
});

describe("LinkChecker", () => {
  it("passes clean hosts", async () => {
    const fetchFn = vi.fn(async () => dohJson(0, [{ data: "203.0.113.7" }]));
    const checker = new LinkChecker({ fetchFn: fetchFn as typeof fetch });
    expect(await checker.checkHost("example.test")).toEqual({ ok: true, reason: "clean", host: "example.test" });
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url.startsWith("https://security.cloudflare-dns.com/dns-query")).toBe(true);
  });

  it("blocks 0.0.0.0 answers", async () => {
    const fetchFn = vi.fn(async () => dohJson(0, [{ data: "0.0.0.0" }]));
    const checker = new LinkChecker({ fetchFn: fetchFn as typeof fetch });
    expect(await checker.checkHost("evil.test")).toMatchObject({ ok: false, reason: "blocked" });
  });

  it("blocks on lookup errors", async () => {
    const down = new LinkChecker({ fetchFn: (async () => new Response("{}", { status: 500 })) as typeof fetch });
    expect(await down.checkHost("example.test")).toMatchObject({ ok: false, reason: "lookup_error" });
    const empty = new LinkChecker({ fetchFn: (async () => dohJson(0, [])) as typeof fetch });
    expect(await empty.checkHost("example.test")).toMatchObject({ ok: false, reason: "lookup_error" });
    const throwing = new LinkChecker({
      fetchFn: (async () => {
        throw new Error("net down");
      }) as typeof fetch,
    });
    expect(await throwing.checkHost("example.test")).toMatchObject({ ok: false, reason: "lookup_error" });
  });

  it("rejects bad URLs", async () => {
    const checker = new LinkChecker({ fetchFn: (async () => dohJson(0, [{ data: "1.1.1.1" }])) as typeof fetch });
    expect(await checker.checkUrl("not a url")).toMatchObject({ ok: false, reason: "bad_url" });
    expect(await checker.checkUrl("ftp://example.test/x")).toMatchObject({ ok: false, reason: "bad_url" });
  });
});

describe("both resolvers", () => {
  function verdict(blocked: boolean): Response {
    return new Response(JSON.stringify({ Status: 0, Answer: [{ data: blocked ? "0.0.0.0" : "203.0.113.7" }] }), {
      status: 200,
      headers: { "content-type": "application/dns-json" },
    });
  }

  it("clears person-visible hosts against family and security", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("family.") && url.includes("name=adult.test")) return verdict(true);
      if (url.includes("security.") && url.includes("name=malware.test")) return verdict(true);
      return verdict(false);
    });
    const checker = new LinkChecker({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(await checker.checkHost("adult.test", true)).toMatchObject({ ok: false, reason: "blocked" });
    expect(await checker.checkHost("malware.test", true)).toMatchObject({ ok: false, reason: "blocked" });
    expect(await checker.checkHost("ok.test", true)).toMatchObject({ ok: true, reason: "clean" });
    expect(calls.filter((c) => c.includes("name=ok.test"))).toHaveLength(2);
  });

  it("checks bare links by their normalized host", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      seen.push(url);
      return verdict(true);
    });
    const checker = new LinkChecker({ fetchFn: fetchFn as unknown as typeof fetch });
    const stripped = await stripBlockedLinks("Do not open EVIL.TEST/trap today.", checker);
    expect(stripped.removed).toBe(1);
    expect(stripped.text).not.toContain("EVIL.TEST");
    expect(seen[0]).toContain("name=evil.test");
  });
});

describe("stripBlockedLinks", () => {
  it("replaces matches in place without touching longer hosts", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const blocked = url.includes("name=evil.test") && !url.includes("name=xevil.test");
      return dohJson(0, [{ data: blocked ? "0.0.0.0" : "203.0.113.7" }]);
    });
    const checker = new LinkChecker({ fetchFn: fetchFn as unknown as typeof fetch });
    const stripped = await stripBlockedLinks("See evil.test/a and xevil.test/a.", checker);
    expect(stripped.removed).toBe(1);
    expect(stripped.text).toBe(`See ${LINK_REMOVED} and xevil.test/a.`);
  });

  it("checks Unicode domains by their punycode", async () => {
    expect(extractLinks("Visit bücher.de/trap today.")).toEqual(["bücher.de/trap"]);
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      seen.push(url);
      return dohJson(0, [{ data: "0.0.0.0" }]);
    });
    const checker = new LinkChecker({ fetchFn: fetchFn as unknown as typeof fetch });
    const stripped = await stripBlockedLinks("Visit bücher.de/trap today.", checker);
    expect(stripped.removed).toBe(1);
    expect(stripped.text).not.toContain("bücher.de");
    expect(seen[0]).toContain("name=xn--bcher-kva.de");
  });

  it("removes blocked links and keeps clean ones", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("name=evil.test")) return dohJson(0, [{ data: "0.0.0.0" }]);
      return dohJson(0, [{ data: "203.0.113.7" }]);
    });
    const checker = new LinkChecker({ fetchFn: fetchFn as unknown as typeof fetch });
    const stripped = await stripBlockedLinks("See https://ok.test/a and https://evil.test/b.", checker);
    expect(stripped.removed).toBe(1);
    expect(stripped.text).toBe(`See https://ok.test/a and ${LINK_REMOVED}.`);
    const [firstUrl] = fetchFn.mock.calls[0] as unknown as [string];
    expect(firstUrl.startsWith("https://family.cloudflare-dns.com/dns-query")).toBe(true);
  });
});

describe("the domain of an email address", () => {
  it("is not a link, subdomains included", () => {
    expect(extractLinks("Write to letters+abc@inbox.example.test today.")).toEqual([]);
    expect(extractLinks("Write to a@b.c.d.example.test today.")).toEqual([]);
  });

  it("does not hide a link beside it", () => {
    expect(extractLinks("a@inbox.example.test or scam.example.com/login")).toEqual(["scam.example.com/login"]);
    expect(extractLinks("a@inbox.example.test, scam.example.com")).toEqual(["scam.example.com"]);
    expect(extractLinks("a_b.evil.example.com")).toEqual(["evil.example.com"]);
    expect(extractLinks("a@b.example.com/evil.example.org")).toEqual(["evil.example.org"]);
    expect(extractLinks("a@https://evil.example.com/x")).toEqual(["https://evil.example.com/x"]);
  });

  it("is left in place when a reply's links are stripped", async () => {
    const checker = new LinkChecker({ fetchFn: (async () => new Response("down", { status: 500 })) as typeof fetch });
    const out = await stripBlockedLinks("Write to a@inbox.example.test or scam.example.com.", checker);
    expect(out.text).toBe(`Write to a@inbox.example.test or ${LINK_REMOVED}.`);
    expect(out.removed).toBe(1);
  });

  it("takes linear time on a long run of labels that never ends in a name", () => {
    const started = Date.now();
    expect(extractLinks("a.".repeat(100_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still finds a link at the end of more labels than a host can hold", () => {
    // Split where the bound falls: a host too long to look up fails the check.
    const links = extractLinks(`${"a.".repeat(200)}evil.example.com/login`);
    expect(links.join(".")).toContain("evil.example.com/login");
    expect(links[0]!.length).toBeGreaterThan(253);
  });

  it("takes linear time on a long run of labels after an @", () => {
    const started = Date.now();
    extractLinks(`@${"a.".repeat(200_000)}test`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
