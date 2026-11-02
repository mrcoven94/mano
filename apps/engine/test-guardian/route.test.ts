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
let checks: { auth: string | null; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  checks = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== "https://guardian.test/check") return real(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.warm === true) return Response.json({ warming: true, ready: true }, { status: 202 });
    checks.push({ auth: request.headers.get("authorization"), body });
    return Response.json(verdict);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function asAgent(method: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://engine.test/api/persons/${PERSON}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      "x-mano-handle-grant": await mintHandleGrant(HANDLE, GRANT_SECRET),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function propose(
  over: Record<string, unknown> = {},
): Promise<{ status: string; reason?: string; approval?: { problems: string[] } }> {
  const res = await asAgent("POST", "/action", {
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: { householdSize: 3 },
    idempotencyKey: `route-${crypto.randomUUID()}`,
    actor: "foreground",
    origin: "person",
    generation: 0,
    ...over,
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

  it("removes the names and employer on the person's profile before asking Guardian", async () => {
    const patched = await asAgent("PATCH", "/profile", {
      idempotencyKey: "route-profile-1",
      source: "person",
      generation: 0,
      fields: {
        "person.fullName": "Maria Synthetic",
        "household.kid1.name": "Leo Synthetic",
        "income.job1.memberId": "self",
        "income.job1.source": "Synthetic Bakery",
      },
    });
    expect(patched.status).toBe(200);
    const said = "Maria Synthetic works at Synthetic Bakery. Leo Synthetic is her son.";
    const result = await propose({
      purpose: "Food benefits renewal for Maria Synthetic of Synthetic Bakery",
      payload: { householdSize: 2, monthlyIncome: 1200, text: said },
      sources: [{ kind: "document", id: "letter-1", quote: said }],
    });
    expect(result.status).toBe("needs_approval");
    expect(checks).toHaveLength(1);
    const wire = JSON.stringify(checks[0]!.body);
    for (const raw of ["Maria Synthetic", "Leo Synthetic", "Synthetic Bakery"]) expect(wire).not.toContain(raw);
    expect(checks[0]!.body.action).toMatchObject({
      purpose: "Food benefits renewal for [NAME] of [EMPLOYER]",
      payload: { householdSize: 2, monthlyIncome: 1200, text: "[NAME] works at [EMPLOYER]. [NAME] is her son." },
    });
    expect(checks[0]!.body.sources).toEqual([
      { kind: "document", id: "letter-1", quote: "[NAME] works at [EMPLOYER]. [NAME] is her son." },
    ]);
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
});
