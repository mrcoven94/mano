import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";

// The agent's service credential: its own token plus a handle grant
// Channels signed for the person who just texted. It reaches only that
// person, only on the memory, action and approvals routes. Every
// cross-person or out-of-scope attempt is refused.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const TEST_SESSION_SECRET = "test-session-secret-not-real";

const HANDLE_A = "a1".repeat(32);
const HANDLE_B = "b2".repeat(32);
const PERSON_A = personIdForHandle(HANDLE_A);
const PERSON_B = personIdForHandle(HANDLE_B);

async function asAgent(
  personId: string,
  path: string,
  init: RequestInit & { grant?: string | null; token?: string } = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${init.token ?? AGENT_TOKEN}`,
    "content-type": "application/json",
  };
  const grant = init.grant === undefined ? await mintHandleGrant(HANDLE_A, GRANT_SECRET) : init.grant;
  if (grant) headers["x-mano-handle-grant"] = grant;
  return SELF.fetch(`https://engine.test/api/persons/${personId}${path}`, { method: init.method, body: init.body, headers });
}

const ACTION = () =>
  JSON.stringify({
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `live3-${crypto.randomUUID()}`,
    actor: "foreground",
    sources: [],
    origin: "person",
    generation: 0,
  });

describe("agent service credential", () => {
  it("acts for the granted person on memory, action and approvals", async () => {
    const added = await asAgent(PERSON_A, "/memory", {
      method: "POST",
      body: JSON.stringify({ content: "Has a renewal due Nov 30.", source: "text", generation: 0 }),
    });
    expect(added.status).toBe(200);
    const { id } = (await added.json()) as { id: string };
    const listed = (await (await asAgent(PERSON_A, "/memory")).json()) as { memories: { id: string }[] };
    expect(listed.memories.map((m) => m.id)).toContain(id);
    expect((await asAgent(PERSON_A, `/memory/${id}`, { method: "DELETE" })).status).toBe(200);

    const action = (await (await asAgent(PERSON_A, "/action", { method: "POST", body: ACTION() })).json()) as {
      status: string;
      approval: { id: string; personId: string };
    };
    expect(action.status).toBe("needs_approval");
    expect(action.approval.personId).toBe(PERSON_A);
    expect((await asAgent(PERSON_A, "/approvals")).status).toBe(200);
    const rejected = (await (
      await asAgent(PERSON_A, `/approvals/${action.approval.id}/reject`, { method: "POST" })
    ).json()) as { status: string };
    expect(rejected.status).toBe("rejected");

    const second = (await (await asAgent(PERSON_A, "/action", { method: "POST", body: ACTION() })).json()) as {
      approval: { id: string };
    };
    const approved = (await (
      await asAgent(PERSON_A, `/approvals/${second.approval.id}/approve`, { method: "POST" })
    ).json()) as { status: string };
    expect(approved.status).toBe("completed");
  });

  it("refuses every cross-person attempt", async () => {
    // Person B's data exists, written by B's own session.
    const sessionB = await mintSessionToken({ kind: "person", sub: PERSON_B }, TEST_SESSION_SECRET);
    const added = await SELF.fetch(`https://engine.test/api/persons/${PERSON_B}/memory`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionB}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "B's private note.", source: "text", generation: 0 }),
    });
    const { id } = (await added.json()) as { id: string };

    // A's grant on B's routes, on a named person, and B's ID in the body.
    for (const [method, path] of [
      ["GET", "/memory"],
      ["POST", "/memory"],
      ["DELETE", `/memory/${id}`],
      ["POST", "/action"],
      ["GET", "/approvals"],
      ["POST", `/approvals/${crypto.randomUUID()}/approve`],
      ["POST", `/approvals/${crypto.randomUUID()}/reject`],
    ] as const) {
      const body = method === "POST" ? JSON.stringify({ content: "x", source: "text", generation: 0 }) : undefined;
      expect((await asAgent(PERSON_B, path, { method, body })).status, `${method} ${path} on B`).toBe(403);
      expect((await asAgent("maria", path, { method, body })).status, `${method} ${path} on maria`).toBe(403);
    }
    const stamped = (await (
      await asAgent(PERSON_A, "/action", { method: "POST", body: JSON.stringify({ ...JSON.parse(ACTION()), personId: PERSON_B }) })
    ).json()) as { approval: { personId: string } };
    expect(stamped.approval.personId).toBe(PERSON_A);

    const listB = (await (
      await SELF.fetch(`https://engine.test/api/persons/${PERSON_B}/memory`, { headers: { authorization: `Bearer ${sessionB}` } })
    ).json()) as { memories: { id: string }[] };
    expect(listB.memories.map((m) => m.id)).toContain(id);
  });

  it("refuses a missing, forged, expired or misused credential", async () => {
    const now = Date.now();
    const cases: [string, Parameters<typeof asAgent>[2]][] = [
      ["no grant", { grant: null }],
      ["wrong agent token", { token: "not-the-agent-token" }],
      ["grant signed with another secret", { grant: await mintHandleGrant(HANDLE_A, "another-secret") }],
      ["expired grant", { grant: await mintHandleGrant(HANDLE_A, GRANT_SECRET, 60, now - 120_000) }],
      ["grant as the bearer", { token: await mintHandleGrant(HANDLE_A, GRANT_SECRET), grant: null }],
      ["agent token as a session", { grant: null, token: AGENT_TOKEN }],
    ];
    for (const [label, init] of cases) {
      expect((await asAgent(PERSON_A, "/memory", init)).status, label).toBe(403);
    }
    // A person session cannot borrow the grant path either.
    const sessionA = await mintSessionToken({ kind: "person", sub: PERSON_A }, TEST_SESSION_SECRET);
    expect((await asAgent(PERSON_A, "/memory", { token: sessionA })).status).toBe(403);
  });

  // Reading a texted photo back (GET /documents/:docId) is the agent's;
  // storing one is Channels' (test/text-documents.test.ts).
  it("refuses routes outside memory, action and approvals", async () => {
    for (const [method, path] of [
      ["POST", "/chat"],
      ["POST", "/documents"],
      ["POST", "/ws-ticket"],
    ] as const) {
      const body = method === "POST" ? "{}" : undefined;
      expect((await asAgent(PERSON_A, path, { method, body })).status, `${method} ${path}`).toBe(403);
    }
    const checkLink = await SELF.fetch("https://engine.test/api/check-link", {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "x-mano-handle-grant": await mintHandleGrant(HANDLE_A, GRANT_SECRET),
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(checkLink.status).toBe(403);
  });
});
