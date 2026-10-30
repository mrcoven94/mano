import { describe, expect, it } from "vitest";
import { ActionGateway, MemoryApprovalStore, SandboxExecutor, TimeoutError } from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";
import { sha256Hex } from "../src/hash.js";

// The sandbox portal's real JSON API (apps/sandbox-portal): POST
// /submissions with a bearer token, { key, household, files }, answers
// { confirmationNumber }; GET /submissions/:key answers it or 404.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const HOUSEHOLD = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1984-03-12",
  address: "100 Sample St, Tacoma, WA 98402",
  phone: "253-555-0142",
  householdSize: "3",
  monthlyIncome: "2150",
};

function req(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: { ...HOUSEHOLD },
    idempotencyKey: "agent:g1:turn-1:d0",
    actor: "foreground",
    personId: "person-rosa",
    document: { bytesB64: PNG, hash: "h" },
    ...over,
  };
}

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function portal(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const entry: Seen = {
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
    };
    seen.push(entry);
    return answer(entry);
  }) as typeof fetch;
  return { seen, fetchFn };
}

describe("SandboxExecutor speaks the sandbox portal's JSON API", () => {
  it("files the household and the verified document with the token and returns the confirmation number", async () => {
    const { seen, fetchFn } = portal(() => Response.json({ status: "received", confirmationNumber: "WA-2026-000123", duplicate: false }));
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    const out = await exec.execute(req());
    expect(out).toEqual({ externalId: "WA-2026-000123" });
    expect(seen[0].url).toBe("https://portal.test/submissions");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].auth).toBe("Bearer portal-token");
    expect(seen[0].body?.household).toEqual(HOUSEHOLD);
    expect(seen[0].body?.files).toEqual([{ name: "document-1.png", type: "image/png", data: PNG }]);
    // The downstream key is scoped to the person and fits the portal's 128-character limit.
    const key = seen[0].body?.key as string;
    expect(key).toBe(`mano-${await sha256Hex("person-rosa:agent:g1:turn-1:d0")}`);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("reconciles by the same key: found answers the confirmation number, 404 is absent", async () => {
    const key = `mano-${await sha256Hex("person-rosa:agent:g1:turn-1:d0")}`;
    const { seen, fetchFn } = portal((s) =>
      s.url.endsWith(`/submissions/${key}`)
        ? Response.json({ key, status: "received", confirmationNumber: "WA-2026-000123" })
        : Response.json({ status: "not_found" }, { status: 404 }),
    );
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    expect(await exec.check("agent:g1:turn-1:d0", "person-rosa")).toEqual({ found: true, externalId: "WA-2026-000123" });
    expect(await exec.check("agent:g1:turn-2:d0", "person-rosa")).toEqual({ found: false });
    expect(seen.every((s) => s.auth === "Bearer portal-token")).toBe(true);
  });

  it("treats a 200 lookup without a confirmation number as unavailable, never absent", async () => {
    const { fetchFn } = portal(() => Response.json({ status: "received" }));
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    await expect(exec.check("k", "person-rosa")).rejects.toThrow(/malformed/i);
  });

  it("records a refused filing as a definite failure", async () => {
    const { fetchFn } = portal(() => Response.json({ error: "Attach at least one document." }, { status: 400 }));
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    await expect(exec.execute(req({ document: undefined }))).rejects.toMatchObject({ name: "DefiniteFailureError" });
  });

  it("after a timeout, reconciles the filing before any retry and never files twice", async () => {
    let filed: string | null = null;
    let posts = 0;
    const { fetchFn } = portal((s) => {
      if (s.method === "POST") {
        posts += 1;
        filed = s.body?.key as string;
        throw new TimeoutError();
      }
      return filed && s.url.endsWith(`/submissions/${filed}`)
        ? Response.json({ status: "received", confirmationNumber: "WA-2026-000777" })
        : Response.json({ status: "not_found" }, { status: 404 });
    });
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token"), {
      policyOverrides: { submit: "allow" },
    });
    // The post timed out after the portal stored it: the gateway asks the
    // portal before calling anything failed, and finds the filing.
    const first = await gw.requestAction(req({ document: undefined }));
    expect(first.status).toBe("reconciled");
    expect(first.receipt?.externalId).toBe("WA-2026-000777");
    const again = await gw.requestAction(req({ document: undefined }));
    expect(again.receipt?.externalId).toBe("WA-2026-000777");
    expect(posts).toBe(1);
  });
});
