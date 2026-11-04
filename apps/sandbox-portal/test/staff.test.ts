import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, handleRequest, type PortalConfig } from "../src/app";
import { TEST_BANNER } from "../src/pages";
import { MemoryFileStore, MemoryStore } from "./memory-store";

// The staff screen against a stand-in that answers as Engine's staff routes
// do. The real pair runs end to end in the PR's local proof; Engine's side
// of these routes is tested in apps/engine/test/case-sharing.test.ts.

const BASE = "https://portal.test";
const TOKEN = "portal-test-token";

interface Call {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

function standInEngine() {
  const state = {
    shared: true,
    down: false,
    calls: [] as Call[],
  };
  const engineFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    state.calls.push({ method: init?.method ?? "GET", path, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (state.down) return new Response("down", { status: 503 });
    if (path === "/api/staff/session") {
      return (JSON.parse(String(init?.body)) as { orgId: string }).orgId === "sandbox-county" && auth === `Bearer ${TOKEN}`
        ? Response.json({ token: "staff-session" })
        : Response.json({ error: "Forbidden." }, { status: 403 });
    }
    if (auth !== "Bearer staff-session") return Response.json({ error: "Forbidden." }, { status: 403 });
    if (path === "/api/orgs/sandbox-county/cases") {
      return Response.json({ cases: state.shared ? [{ caseId: "renewal-1", purpose: "your food benefits renewal", sharedAt: "2026-11-03T00:00:00.000Z" }] : [] });
    }
    if (!state.shared) return Response.json({ error: "This case is not shared with this organization." }, { status: 404 });
    if (path === "/api/orgs/sandbox-county/cases/renewal-1") {
      return Response.json({
        case: {
          caseId: "renewal-1",
          purpose: "your food benefits renewal",
          sharedAt: "2026-11-03T00:00:00.000Z",
          details: [{ label: "Name", value: "<b>Maria Testcase</b>" }],
          requests: [{ id: "r1", label: "pay stub", status: "open", requestedAt: "2026-11-03T01:00:00.000Z" }],
          documents: [{ id: "doc-1", name: "stub.png", label: "pay stub", providedAt: "2026-11-03T02:00:00.000Z" }],
          requestableKinds: { "pay-stub": "pay stub" },
        },
      });
    }
    if (path === "/api/orgs/sandbox-county/cases/renewal-1/document-requests") return Response.json({ status: "requested" }, { status: 201 });
    if (path === "/api/orgs/sandbox-county/cases/renewal-1/documents/doc-1") {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-disposition": 'attachment; filename="stub.png"' } });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  return { state, engineFetch };
}

function setup(overrides: Partial<PortalConfig> = {}) {
  const engine = standInEngine();
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  const config: PortalConfig = { ...DEFAULT_CONFIG, portalToken: TOKEN, engineUrl: "https://engine.test", sandboxOrgId: "sandbox-county", engineFetch: engine.engineFetch, ...overrides };
  const call = (path: string, init?: RequestInit) => handleRequest(new Request(`${BASE}${path}`, init), store, files, config);
  const post = (path: string, fields: Record<string, string>, cookie?: string, extra?: Record<string, string>) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...extra },
      body: new URLSearchParams(fields).toString(),
    });
  const signIn = async () => {
    const res = await post("/staff/sign-in", { password: TOKEN });
    expect(res.status).toBe(303);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  return { ...engine, call, post, signIn };
}

describe("staff sign-in", () => {
  test("shows the sign-in page and calls Engine for nothing before sign-in", async () => {
    const { call, state } = setup();
    const res = await call("/staff");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Staff sign-in");
    expect(body).toContain(TEST_BANNER);
    const deep = await call("/staff/cases/renewal-1");
    expect(deep.status).toBe(303);
    expect(deep.headers.get("location")).toBe("/staff");
    expect(state.calls).toEqual([]);
  });

  test("refuses a wrong token and a forged or expired cookie", async () => {
    const { call, post, state } = setup();
    expect((await post("/staff/sign-in", { password: "wrong" })).status).toBe(401);
    const future = Date.now() + 3_600_000;
    expect((await call("/staff/cases/renewal-1", { headers: { cookie: `mano_staff=${future}.${"0".repeat(64)}` } })).status).toBe(303);
    expect((await call("/staff/cases/renewal-1", { headers: { cookie: `mano_staff=${future}` } })).status).toBe(303);
    expect(state.calls).toEqual([]);
  });

  test("a cookie stops working when it expires", async () => {
    let now = Date.now();
    const { call, post } = setup({ now: () => now });
    const res = await post("/staff/sign-in", { password: TOKEN });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await call("/staff", { headers: { cookie } })).status).toBe(200);
    now += 9 * 3600_000;
    expect(await (await call("/staff", { headers: { cookie } })).text()).toContain("Staff sign-in");
  });

  test("the cookie is locked down and signing out clears it", async () => {
    const { post, signIn } = setup();
    const set = (await post("/staff/sign-in", { password: TOKEN })).headers.get("set-cookie") ?? "";
    for (const part of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/staff"]) expect(set).toContain(part);
    const out = await post("/staff/sign-out", {}, await signIn());
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("the staff view is off until it is configured", async () => {
    expect((await setup({ engineUrl: "" }).call("/staff")).status).toBe(503);
    expect((await setup({ portalToken: "" }).call("/staff")).status).toBe(503);
  });

  test("asks Engine for the sandbox org, and only with its own session", async () => {
    const { call, signIn, state } = setup();
    await call("/staff", { headers: { cookie: await signIn() } });
    expect(state.calls[0]).toMatchObject({ method: "POST", path: "/api/staff/session", body: { orgId: "sandbox-county" } });
    expect(state.calls[1]).toMatchObject({ path: "/api/orgs/sandbox-county/cases", auth: "Bearer staff-session" });
  });
});

describe("the shared case", () => {
  test("shows what Engine returns, escaped, and is never cached", async () => {
    const { call, signIn } = setup();
    const res = await call("/staff/cases/renewal-1", { headers: { cookie: await signIn() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("&lt;b&gt;Maria Testcase&lt;/b&gt;");
    expect(body).not.toContain("<b>Maria");
    expect(body).toContain("stub.png");
    expect(body).toContain(TEST_BANNER);
  });

  test("a request goes to Engine with the key the form carried, and comes back to the case", async () => {
    const { post, signIn, state } = setup();
    const res = await post("/staff/cases/renewal-1/requests", { documentKind: "pay-stub", key: "key-12345678" }, await signIn());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/staff/cases/renewal-1");
    expect(state.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/orgs/sandbox-county/cases/renewal-1/document-requests",
      body: { documentKind: "pay-stub", idempotencyKey: "key-12345678" },
    });
  });

  test("a form posted from another site is refused", async () => {
    const { post, signIn, state } = setup();
    const cookie = await signIn();
    const res = await post("/staff/cases/renewal-1/requests", { documentKind: "pay-stub", key: "key-12345678" }, cookie, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  test("a document downloads as an attachment", async () => {
    const { call, signIn } = setup();
    const res = await call("/staff/cases/renewal-1/documents/doc-1", { headers: { cookie: await signIn() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("once the resident stops sharing, every route says so and shows nothing", async () => {
    const { call, post, signIn, state } = setup();
    const cookie = await signIn();
    state.shared = false;
    const headers = { cookie };
    const list = await (await call("/staff", { headers })).text();
    expect(list).toContain("No resident is sharing");
    expect(list).not.toContain("renewal-1");
    for (const res of [
      await call("/staff/cases/renewal-1", { headers }),
      await call("/staff/cases/renewal-1/documents/doc-1", { headers }),
      await post("/staff/cases/renewal-1/requests", { documentKind: "pay-stub", key: "key-12345678" }, cookie),
    ]) {
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).toContain("not shared with this office");
      expect(body).not.toContain("Maria");
    }
  });

  test("when Engine cannot answer, it shows nothing and says so", async () => {
    const { call, signIn, state } = setup();
    const cookie = await signIn();
    state.down = true;
    const res = await call("/staff/cases/renewal-1", { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("Maria");
  });
});
