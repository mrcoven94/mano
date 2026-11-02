import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PlaywrightComputer } from "../src/playwright";

// Real Chromium on this machine. CI has no browser installed and skips.
const installed = existsSync(chromium.executablePath());

function recorder(pages: (other: string) => Record<string, { status?: number; headers?: Record<string, string>; body?: string }>) {
  const hits: string[] = [];
  let other = "";
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const page = pages(other)[req.url ?? ""] ?? { body: "ok" };
    res.writeHead(page.status ?? 200, { "content-type": "text/html", ...page.headers });
    res.end(page.body ?? "");
  });
  return {
    hits,
    server,
    setOther(origin: string) {
      other = origin;
    },
    origin: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

describe.skipIf(!installed)("playwright stand-in in real Chromium", () => {
  const offsite = recorder(() => ({}));
  const portal = recorder((elsewhere) => ({
    "/apply": { body: "<h1>Renewal</h1>" },
    "/redirect": { status: 302, headers: { location: `${elsewhere}/redirected` } },
    "/chain": { status: 302, headers: { location: "/redirect" } },
    "/popup": {
      body: `<button style="position:fixed;inset:0;width:100%;height:100%" onclick="fetch('/clicked');window.open('${elsewhere}/popup')">Open</button>`,
    },
    "/form": {
      body: `<form method="post" action="${elsewhere}/form"><input name="household" value="synthetic"></form><script>fetch('/loaded').then(() => document.forms[0].submit())</script>`,
    },
    "/subresources": { body: `<img src="${elsewhere}/img.png"><script>fetch('${elsewhere}/fetch').catch(() => fetch('/fetch-refused'))</script>` },
  }));
  let computer: PlaywrightComputer;

  beforeAll(async () => {
    await listen(offsite.server);
    await listen(portal.server);
    portal.setOther(offsite.origin());
    computer = new PlaywrightComputer({ allowedOrigins: [portal.origin()], width: 800, height: 600 });
    await computer.goto(`${portal.origin()}/apply`);
  });

  beforeEach(() => {
    offsite.hits.length = 0;
  });

  afterAll(async () => {
    await computer.close();
    offsite.server.close();
    portal.server.close();
  });

  test("a redirect off the portal is refused before it is sent", async () => {
    await computer.goto(`${portal.origin()}/redirect`).catch(() => undefined);
    await settle();
    expect(portal.hits).toContain("GET /redirect");
    expect(offsite.hits).toEqual([]);
  });

  test("a redirect chain that leaves the portal on its second hop is refused", async () => {
    await computer.goto(`${portal.origin()}/chain`).catch(() => undefined);
    await settle();
    expect(portal.hits).toEqual(expect.arrayContaining(["GET /chain", "GET /redirect"]));
    expect(offsite.hits).toEqual([]);
  });

  test("a popup off the portal is refused before it is sent", async () => {
    await computer.goto(`${portal.origin()}/popup`);
    await computer.act([{ type: "click", button: "left", x: 400, y: 300 }]);
    await settle();
    expect(portal.hits).toContain("GET /clicked");
    expect(offsite.hits).toEqual([]);
  });

  test("a form that posts off the portal is refused before it is sent", async () => {
    await computer.goto(`${portal.origin()}/form`);
    await settle();
    expect(portal.hits).toContain("GET /loaded");
    expect(offsite.hits).toEqual([]);
  });

  test("images and fetches off the portal are refused too", async () => {
    await computer.goto(`${portal.origin()}/subresources`);
    await settle();
    expect(portal.hits).toContain("GET /fetch-refused");
    expect(offsite.hits).toEqual([]);
  });
});
