import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSessionSecret, sessionConfigured } from "../src/auth.js";

// Re-review blocker 1: a missing SESSION_SECRET must never fall back to a
// published dev secret outside explicit development, and /health must not
// say which side the secret is on.

describe("r2 blocker 1: no dev session secret outside development", () => {
  it("refuses to sign sessions without a secret unless MANO_ENV=development", () => {
    expect(getSessionSecret({})).toBeNull();
    expect(getSessionSecret({ MANO_ENV: "production" })).toBeNull();
    const dev = getSessionSecret({ MANO_ENV: "development" });
    expect(dev?.dev).toBe(true);
    const live = getSessionSecret({ SESSION_SECRET: "real-secret", MANO_ENV: "development" });
    expect(live).toEqual({ secret: "real-secret", dev: false });
  });

  it("reports sessions misconfigured when no secret exists outside development", () => {
    expect(sessionConfigured({})).toBe(false);
    expect(sessionConfigured({ MANO_ENV: "development" })).toBe(true);
    expect(sessionConfigured({ SESSION_SECRET: "real-secret" })).toBe(true);
  });

  it("leaves the session secret off the public health route", async () => {
    const res = await SELF.fetch("https://mano.test/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: Record<string, unknown> };
    expect("sessionSecret" in body.live).toBe(false);
  });
});
