import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CATALOG, PROGRAMS, STATES, type Fact } from "../src/index.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const BLOCK_PAGE = /just a moment|incapsula|attention required|access denied|enable javascript and cookies/i;
const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|td|th|h[1-6]|table|section|article|header|footer|ul|ol)\b[^>]*>/gi;

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos|rsquo|lsquo);/g, "'")
    .replace(/&(?:ldquo|rdquo);/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function flat(s: string): string {
  return s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

function htmlText(html: string): string {
  return decode(html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(BLOCK_TAGS, " ").replace(/<[^>]+>/g, ""));
}

function pdfText(bytes: Buffer): string | null {
  const dir = mkdtempSync(join(tmpdir(), "mano-source-"));
  const file = join(dir, "source.pdf");
  writeFileSync(file, bytes);
  try {
    return execFileSync("pdftotext", [file, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

type Page = { kind: "text"; text: string; html: string } | { kind: "blocked"; why: string };
const pages = new Map<string, Promise<Page>>();

async function fetchPage(url: string): Promise<Page> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" }, redirect: "follow" });
  } catch (err) {
    return { kind: "blocked", why: `fetch failed (${err instanceof Error ? err.message : "error"})` };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) return { kind: "blocked", why: `HTTP ${res.status}` };
  const isPdf = (res.headers.get("content-type") ?? "").includes("pdf") || bytes.subarray(0, 5).toString() === "%PDF-";
  if (isPdf) {
    const text = pdfText(bytes);
    return text === null ? { kind: "blocked", why: "PDF, and pdftotext is not installed" } : { kind: "text", text, html: "" };
  }
  const html = bytes.toString("utf8");
  const text = htmlText(html);
  if (BLOCK_PAGE.test(text) && text.length < 5000) return { kind: "blocked", why: "bot challenge page" };
  if (text.replace(/\s+/g, "").length < 200) return { kind: "blocked", why: "page renders its text with JavaScript" };
  return { kind: "text", text, html };
}

function page(url: string): Promise<Page> {
  if (!pages.has(url)) pages.set(url, fetchPage(url));
  return pages.get(url)!;
}

type Sourced = Omit<Fact<unknown>, "value">;
const isSourced = (v: unknown): v is Sourced => Boolean(v && typeof v === "object" && "sourceUrl" in v);

const facts = STATES.flatMap((state) =>
  PROGRAMS.flatMap((program) => {
    const entry = CATALOG[state].programs[program];
    const statewide = Object.entries(entry).filter(([, v]) => isSourced(v)) as [string, Fact<unknown>][];
    const tables = (["incomeLimit", "netIncomeLimit"] as const).flatMap((k) =>
      (entry[k]?.value.tables ?? []).flatMap((t, i) => (t.source ? [[`${k} table ${i + 1}`, t.source] as [string, Sourced]] : [])),
    );
    const areas = (entry.areas ?? []).flatMap((a) => Object.entries(a.facts).map(([k, v]) => [`${a.area} ${k}`, v as Sourced] as [string, Sourced]));
    return [...statewide, ...tables, ...areas].map(([field, fact]) => ({ id: `${state} ${program} ${field}`, fact }));
  }),
);

describe("every quote is on its source page", () => {
  it.for(facts)("$id", async ({ fact }, ctx) => {
    const p = await page(fact.sourceUrl);
    if (p.kind === "blocked") return ctx.skip(`${fact.sourceUrl}: ${p.why}`);
    expect(flat(p.text)).toContain(flat(fact.quote));
  });
});

const sites = STATES.flatMap((state) => CATALOG[state].documentedSites.map((site) => ({ id: `${state} ${site.host}`, site })));

describe("every documented site is named and linked on its .gov page", () => {
  it.for(sites)("$id", async ({ site }, ctx) => {
    const p = await page(site.sourceUrl);
    if (p.kind === "blocked") return ctx.skip(`${site.sourceUrl}: ${p.why}`);
    expect(flat(p.text)).toContain(flat(site.quote));
    if (p.html) expect(p.html.toLowerCase()).toContain(site.host.toLowerCase());
  });
});
