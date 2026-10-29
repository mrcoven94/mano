import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { healthOk } from "../src/index.js";
import { mintSessionToken } from "../src/auth.js";
import type { Env } from "../src/env.js";

// Outside development, the engine refuses every business request while a
// required part of its production config is missing; /health still
// answers, with ok:false. ok:true needs the agent token and the grant
// secret as well as the rest.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

function production(over: Partial<Env> = {}): Env {
  return { ...(testEnv as unknown as Env), MANO_ENV: undefined, EXECUTOR_MODE: "simulated", ...over };
}

async function memoryList(env: Env): Promise<Response> {
  const token = await mintSessionToken({ kind: "person", sub: "r2cfg-maria" }, TEST_SESSION_SECRET);
  return worker.fetch(
    new Request("https://engine.test/api/persons/r2cfg-maria/memory", { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
}

describe("production config gate", () => {
  it("serves business routes only with complete production config", async () => {
    expect((await memoryList(production())).status).toBe(200);
    for (const missing of [
      "MANO_ENGINE_AGENT_TOKEN",
      "MANO_HANDLE_GRANT_SECRET",
      "MANO_ENGINE_CHANNELS_TOKEN",
      "MANO_CHANNELS_URL",
      "MANO_ENGINE_SEND_SECRET",
      "META_MODEL_API_KEY",
      "EXECUTOR_MODE",
    ] as const) {
      const env = production({ [missing]: undefined });
      expect((await memoryList(env)).status, `without ${missing}`).toBe(503);
      const health = await worker.fetch(new Request("https://engine.test/health"), env);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok, `health without ${missing}`).toBe(false);
    }
  });

  it("health is ok only with the agent token and grant secret", () => {
    const full = production();
    expect(healthOk(full)).toBe(true);
    expect(healthOk({ ...full, MANO_ENGINE_AGENT_TOKEN: undefined })).toBe(false);
    expect(healthOk({ ...full, MANO_HANDLE_GRANT_SECRET: undefined })).toBe(false);
  });
});
