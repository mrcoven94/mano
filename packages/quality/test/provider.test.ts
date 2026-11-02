// The provider check names a billing outage (HTTP 402) as its own outcome
// and leaves every other failure to the live run, which fails as before.

import assert from "node:assert/strict";
import test from "node:test";
import { checkProvider, classifyProviderResponse, unavailableSummary } from "../src/provider.ts";

const BILLING_402 = JSON.stringify({ error: { message: "Billing is not configured for this account.", type: "billing_error", code: "billing_not_configured" } });
const env = { META_MODEL_API_KEY: "test-key", MANO_MODEL_BENCH_ID: "muse-spark-1.3-contributor" };

function respond(status: number, body: string, seen: { url: string; body: string }[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body) });
    return new Response(body, { status });
  }) as typeof fetch;
}

test("a 402 billing error is the provider being unavailable, with its type and code", async () => {
  const seen: { url: string; body: string }[] = [];
  const check = await checkProvider(env, respond(402, BILLING_402, seen));
  assert.deepEqual(check, { state: "unavailable", status: 402, errorType: "billing_error", errorCode: "billing_not_configured" });
  assert.equal(seen[0]!.url, "https://api.meta.ai/v1/responses");
  assert.equal(JSON.parse(seen[0]!.body).store, false);
  const text = unavailableSummary("smoke", check as Extract<typeof check, { state: "unavailable" }>);
  assert.match(text, /model provider unavailable/);
  assert.match(text, /billing_error \/ billing_not_configured/);
  assert.ok(!text.includes("Billing is not configured"), "provider message text must not be copied");
});

test("401, 403, 429 and 5xx are not the provider being unavailable", () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    assert.deepEqual(classifyProviderResponse(status, BILLING_402), { state: "error", detail: `http_${status}` }, String(status));
  }
});

test("a 402 without a JSON body is still unavailable; a 200 is available", () => {
  assert.deepEqual(classifyProviderResponse(402, "Payment Required"), { state: "unavailable", status: 402, errorType: null, errorCode: null });
  assert.deepEqual(classifyProviderResponse(200, "{}"), { state: "available" });
});

test("a network failure runs the suite as before, and no key means no check", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.deepEqual(await checkProvider(env, down), { state: "error", detail: "TypeError" });
  assert.equal(await checkProvider({}, respond(402, BILLING_402)), null);
});
