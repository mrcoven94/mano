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

describe("stripBlockedLinks", () => {
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
