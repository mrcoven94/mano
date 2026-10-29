import { describe, expect, it } from "vitest";
import { signPagesBody, verifyPagesRequest } from "../src/auth.js";

const SECRET = "test pages hmac secret";

describe("pages HMAC auth", () => {
  it("signs and verifies a body", async () => {
    const now = 1_800_000_000;
    const header = await signPagesBody(SECRET, now, '{"kind":"estimate"}');
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const check = await verifyPagesRequest('{"kind":"estimate"}', header, SECRET, now);
    expect(check.ok).toBe(true);
  });

  it("refuses a tampered body", async () => {
    const now = 1_800_000_000;
    const header = await signPagesBody(SECRET, now, '{"kind":"estimate"}');
    const check = await verifyPagesRequest('{"kind":"approve"}', header, SECRET, now);
    expect(check.ok).toBe(false);
  });

  it("refuses a stale or future timestamp", async () => {
    const now = 1_800_000_000;
    const old = await signPagesBody(SECRET, now - 301, "{}");
    expect((await verifyPagesRequest("{}", old, SECRET, now)).ok).toBe(false);
    const future = await signPagesBody(SECRET, now + 301, "{}");
    expect((await verifyPagesRequest("{}", future, SECRET, now)).ok).toBe(false);
    const edge = await signPagesBody(SECRET, now - 300, "{}");
    expect((await verifyPagesRequest("{}", edge, SECRET, now)).ok).toBe(true);
  });

  it("refuses a missing or malformed header", async () => {
    expect((await verifyPagesRequest("{}", null, SECRET, 1)).ok).toBe(false);
    expect((await verifyPagesRequest("{}", "bearer abc", SECRET, 1)).ok).toBe(false);
    expect((await verifyPagesRequest("{}", "t=abc,v1=zzz", SECRET, 1)).ok).toBe(false);
  });

  it("refuses the wrong secret", async () => {
    const header = await signPagesBody("other secret", 100, "{}");
    expect((await verifyPagesRequest("{}", header, SECRET, 100)).ok).toBe(false);
  });
});
