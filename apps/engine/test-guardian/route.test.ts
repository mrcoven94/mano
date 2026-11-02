import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";

// The live path with Guardian configured (vitest.guardian.config.ts): the
// agent's POST /action reaches the person's agent, its gateway asks
// Guardian, and the answer decides whether the person is asked. Guardian
// is a stubbed fetch on its URL; everything else is the real Worker.

const AGENT_TOKEN = "test-agent-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const HANDLE = "c3".repeat(32);
const PERSON = personIdForHandle(HANDLE);

let verdict: { verdict: string; problems: string[] } = { verdict: "pass", problems: [] };
// False: Guardian answers every check with an error status, as it can
// while it starts.
let guardianUp = true;
let checks: { auth: string | null; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  checks = [];
  guardianUp = true;
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://guardian.test/check") return real(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.warm === true) return Response.json({ warming: true, ready: true }, { status: 202 });
    checks.push({ auth: request.headers.get("authorization"), body });
    if (!guardianUp) return Response.json({ error: "starting" }, { status: 503 });
    return Response.json(verdict);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function headers() {
  return {
    authorization: `Bearer ${AGENT_TOKEN}`,
    "x-mano-handle-grant": await mintHandleGrant(HANDLE, GRANT_SECRET),
    "content-type": "application/json",
  };
}

async function approve(approvalId: string): Promise<{ status: string; reason?: string; retryable?: boolean }> {
  const res = await SELF.fetch(`https://engine.test/api/persons/${PERSON}/approvals/${approvalId}/approve`, {
    method: "POST",
    headers: await headers(),
  });
  return res.json();
}

async function propose(): Promise<{ status: string; reason?: string; approval?: { id: string; problems: string[] } }> {
  const res = await SELF.fetch(`https://engine.test/api/persons/${PERSON}/action`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({
      type: "submit",
      recipient: "sandbox-agency-portal",
      purpose: "Food benefits renewal in the sandbox agency portal",
      payload: { householdSize: 3 },
      idempotencyKey: `route-${crypto.randomUUID()}`,
      actor: "foreground",
      origin: "person",
      generation: 0,
    }),
  });
  return res.json();
}

describe("Guardian on Engine's action route", () => {
  it("says guardian on /health", async () => {
    const body = (await (await SELF.fetch("https://engine.test/health")).json()) as { ok: boolean; live: { checker: string } };
    expect(body).toMatchObject({ ok: true, live: { checker: "guardian" } });
  });

  it("asks the person only after Guardian passes", async () => {
    verdict = { verdict: "pass", problems: [] };
    const result = await propose();
    expect(result.status).toBe("needs_approval");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.auth).toBe("Bearer guardian-token-not-real");
    expect(checks[0]!.body.action).toMatchObject({ type: "submit", recipient: "[RECIPIENT]" });
  });

  it("carries a fix onto the approval and refuses a block", async () => {
    verdict = { verdict: "fix", problems: ["Say which month the income is for."] };
    const fixed = await propose();
    expect(fixed.status).toBe("needs_approval");
    expect(fixed.approval?.problems).toEqual(["Say which month the income is for."]);

    verdict = { verdict: "block", problems: ["The recipient looks wrong."] };
    const blocked = await propose();
    expect(blocked).toMatchObject({ status: "blocked", reason: "Blocked by review: The recipient looks wrong." });
  });

  it("answers a yes that finds Guardian unavailable as retryable, and a later yes goes through", async () => {
    verdict = { verdict: "pass", problems: [] };
    const drafted = await propose();
    expect(drafted.status).toBe("needs_approval");

    guardianUp = false;
    const down = await approve(drafted.approval!.id);
    expect(down).toMatchObject({ status: "blocked", retryable: true });
    expect(down.reason).toMatch(/safety check returned an error/);

    guardianUp = true;
    const up = await approve(drafted.approval!.id);
    expect(up.status).toBe("completed");
    expect(up.retryable).toBeUndefined();
  });
});
