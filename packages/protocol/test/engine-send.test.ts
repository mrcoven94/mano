import { describe, expect, it } from "vitest";
import { signEngineSend, verifyEngineSend } from "../src/index.js";

// The Engine-to-Channels signature. The vector was computed with node's
// own HMAC over the documented bytes, independent of this code, and is
// the one the Channels receiver pins too.

const BODY = '{"handleHash":"ab"}';
const VECTOR = "82cbcf6537db403e7a8b12a4b12dad407291deb044039a06e308d716b23e5bd9";

describe("engine send signature", () => {
  it("matches the interop vector", async () => {
    expect(await signEngineSend("interop-secret", "POST", "/internal/agent-send", "1761777000", BODY)).toBe(VECTOR);
  });

  it("verifies only the exact method, path, timestamp, body and secret", async () => {
    const good = { method: "POST", path: "/internal/agent-send", timestamp: "1761777000", signature: VECTOR, body: BODY };
    expect(await verifyEngineSend("interop-secret", good, 1761777000)).toEqual({ ok: true });
    const cases: [string, Partial<typeof good>, string?][] = [
      ["another method", { method: "PUT" }],
      ["another path", { path: "/internal/other" }],
      ["another body", { body: '{"handleHash":"cd"}' }],
      ["another timestamp", { timestamp: "1761777001" }],
    ];
    for (const [label, change] of cases) {
      expect((await verifyEngineSend("interop-secret", { ...good, ...change }, 1761777000)).ok, label).toBe(false);
    }
    expect(await verifyEngineSend("another-secret", good, 1761777000)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyEngineSend("interop-secret", good, 1761777000 + 301)).toEqual({ ok: false, reason: "stale" });
    expect(await verifyEngineSend("interop-secret", { ...good, signature: null }, 1761777000)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyEngineSend(undefined, good, 1761777000)).toEqual({ ok: false, reason: "missing" });
  });
});
