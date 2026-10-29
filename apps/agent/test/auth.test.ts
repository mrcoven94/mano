import { describe, expect, it } from "vitest";

import { signBody, verifyRequest } from "../agent/lib/auth.js";

const SECRET = "test-secret";
const NOW = 1_761_770_000;

describe("channel auth", () => {
  it("signs and verifies a body", () => {
    const raw = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    const sig = signBody(SECRET, NOW, raw);
    expect(verifyRequest(SECRET, String(NOW), sig, raw, NOW)).toEqual({ ok: true });
  });

  it("rejects tampered bodies, stale timestamps, and missing parts", () => {
    const raw = new TextEncoder().encode("hello");
    const sig = signBody(SECRET, NOW, raw);
    expect(verifyRequest(SECRET, String(NOW), sig, new TextEncoder().encode("bye"), NOW).ok).toBe(false);
    expect(verifyRequest(SECRET, String(NOW - 301), signBody(SECRET, NOW - 301, raw), raw, NOW)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(verifyRequest(SECRET, "now", sig, raw, NOW)).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verifyRequest(undefined, String(NOW), sig, raw, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(verifyRequest(SECRET, String(NOW), "zz", raw, NOW).ok).toBe(false);
  });

  it("accepts edges of the skew window", () => {
    const raw = new TextEncoder().encode("hello");
    for (const ts of [NOW - 300, NOW + 300]) {
      expect(verifyRequest(SECRET, String(ts), signBody(SECRET, ts, raw), raw, NOW).ok).toBe(true);
    }
  });

  it("matches the shared interop vector (same construction as Channels)", () => {
    // packages/channels/test/agent.test.ts pins this same vector through
    // the WebCrypto verifier, proving both sides interoperate.
    expect(signBody("interop-secret", 1761777000, '{"handleHash":"ab"}')).toBe(
      "042f17f9f8d6de11a23f0ca0c1ae55daba175a48af001583e909d62407e37096",
    );
  });
});
