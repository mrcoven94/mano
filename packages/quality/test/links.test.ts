// D12: live DNS requires a successful answer from each resolver. One error,
// one empty answer, or a filtered address blocks the link.

import assert from "node:assert/strict";
import test from "node:test";
import { DohDns, LocalDns, checkLink } from "../src/links.ts";

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const r = handler(String(url));
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const answer = (ip: string) => ({ Answer: [{ type: 1, data: ip }] });

test("both resolvers must answer or the link is blocked", async () => {
  const dns = new DohDns("https://security.test/dns-query", "https://family.test/dns-query");

  let restore = stubFetch((url) => ({ ok: true, status: 200, body: url.includes("security") ? answer("93.184.216.34") : answer("93.184.216.34") }));
  assert.equal((await checkLink("https://office.example-real.test/renew", dns)).pass, true);
  restore();

  restore = stubFetch((url) => ({ ok: true, status: 200, body: url.includes("security") ? answer("93.184.216.34") : {} }));
  assert.equal((await checkLink("https://office.example-real.test/renew", dns)).pass, false);
  restore();

  restore = stubFetch((url) => (url.includes("family") ? { ok: false, status: 500, body: {} } : { ok: true, status: 200, body: answer("93.184.216.34") }));
  assert.equal((await checkLink("https://office.example-real.test/renew", dns)).pass, false);
  restore();

  restore = stubFetch(() => ({ ok: true, status: 200, body: answer("0.0.0.0") }));
  assert.equal((await checkLink("https://office.example-real.test/renew", dns)).pass, false);
  restore();
});

test("local DNS keeps fixture verdicts", async () => {
  const dns = new LocalDns();
  assert.equal((await checkLink("https://www.ca-food-help.example/apply", dns)).pass, true);
  assert.equal((await checkLink("http://secure-login-benefits.example/verify-now", dns)).pass, false);
  assert.equal((await checkLink("https://unknown-host.example/x", dns)).pass, false);
});
