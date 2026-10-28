import { describe, expect, it } from "vitest";
import { computeSignatureHex, verifySignature } from "../src/verify.js";

const SECRET = "test-webhook-secret-not-real";
const BODY = JSON.stringify({ id: "evt_test_1", type: "message.sent", data: {} });
const NOW = 1_800_000_000;

async function headerFor(t: number, body: string = BODY): Promise<string> {
  const v1 = await computeSignatureHex(SECRET, String(t), body);
  return `t=${t},v1=${v1}`;
}

describe("verifySignature", () => {
  it("accepts a good signature", async () => {
    const check = await verifySignature(BODY, await headerFor(NOW), SECRET, NOW);
    expect(check.ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const header = await headerFor(NOW);
    const check = await verifySignature(`${BODY} `, header, SECRET, NOW);
    expect(check).toMatchObject({ ok: false, failure: "mismatch" });
  });

  it("rejects a wrong secret", async () => {
    const v1 = await computeSignatureHex("another-secret", String(NOW), BODY);
    const check = await verifySignature(BODY, `t=${NOW},v1=${v1}`, SECRET, NOW);
    expect(check).toMatchObject({ ok: false, failure: "mismatch" });
  });

  it("rejects a stale timestamp", async () => {
    const check = await verifySignature(BODY, await headerFor(NOW - 301), SECRET, NOW);
    expect(check).toMatchObject({ ok: false, failure: "stale" });
  });

  it("accepts the edge of the window", async () => {
    const check = await verifySignature(BODY, await headerFor(NOW - 300), SECRET, NOW);
    expect(check.ok).toBe(true);
  });

  it("rejects a far-future timestamp", async () => {
    const check = await verifySignature(BODY, await headerFor(NOW + 301), SECRET, NOW);
    expect(check).toMatchObject({ ok: false, failure: "future" });
  });

  it("rejects a missing or malformed header", async () => {
    expect(await verifySignature(BODY, null, SECRET, NOW)).toMatchObject({ ok: false, failure: "missing_header" });
    expect(await verifySignature(BODY, "nope", SECRET, NOW)).toMatchObject({ ok: false, failure: "bad_format" });
    expect(await verifySignature(BODY, "t=abc,v1=12", SECRET, NOW)).toMatchObject({ ok: false, failure: "bad_format" });
  });
});
