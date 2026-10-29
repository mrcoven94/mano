import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";
import { signAgentSend } from "../src/channels-send.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// The agent's per-person state through the real worker and PersonAgent:
// reminders delivered by the alarm through Channels' agent-send route,
// the turn ledger, the generation-checked pending approval pointer, and
// the conversation delete Channels or the agent can call.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const AGENT_SECRET = "test-agent-secret-not-real";
const SESSION_SECRET = "test-session-secret-not-real";

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(
  handleHash: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string; grantFor?: string } = {},
) {
  const grant = await mintHandleGrant(opts.grantFor ?? handleHash, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(handleHash)}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.token ?? AGENT_TOKEN}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Sent = { url: string; headers: Record<string, string>; body: string };

function recordChannels(reply: () => Response = () => Response.json({ sent: true })): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), headers, body: String(init?.body ?? "") });
    return reply();
  });
  return sent;
}

function stubFor(handleHash: string) {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(personIdForHandle(handleHash)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const past = () => new Date(Date.now() - 1000).toISOString();
const later = "2026-12-01T15:00:00.000Z";

// Time passing, in SQL: makes every waiting reminder due now, so a test
// can run delivery itself without racing the real alarm.
async function makeDue(handleHash: string) {
  await runInDurableObject(stubFor(handleHash), (_i, state) => {
    state.storage.sql.exec("UPDATE reminders SET next_at_ms = ? WHERE status = 'scheduled'", Date.now() - 1);
  });
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

describe("reminders", () => {
  it("one ID is one reminder, two IDs at one time stay two, and a changed one conflicts", async () => {
    const h = handle("rem-identity");
    const r = { id: "turn-1:0", text: "Call the county about the renewal.", dueAt: "2026-12-01T15:00:00.000Z", generation: 2 };
    expect((await call(h, "POST", "/reminders", r)).status).toBe(201);
    const again = await call(h, "POST", "/reminders", r);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("existing");
    expect((await call(h, "POST", "/reminders", { ...r, id: "turn-1:1" })).status).toBe(201);
    expect((await call(h, "POST", "/reminders", { ...r, text: "Something else." })).status).toBe(409);
    const list = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { id: string }[] };
    expect(list.reminders.map((x) => x.id)).toEqual(["turn-1:0", "turn-1:1"]);
    expect((await call(h, "POST", "/reminders", { ...r, id: "https://portal.example/x" })).status).toBe(400);
  });

  it("the alarm delivers a due reminder by itself, once, signed, under its key and generation", async () => {
    const h = handle("rem-deliver");
    const sent = recordChannels();
    await call(h, "POST", "/reminders", { id: "turn-2:0", text: "Your renewal is due Friday.", dueAt: past(), generation: 5 });
    await until(() => sent.length > 0);
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe("https://channels.test/internal/agent-send");
    expect(JSON.parse(sent[0].body)).toEqual({
      handleHash: h,
      key: "reminder:turn-2:0",
      text: "Your renewal is due Friday.",
      generation: 5,
    });
    const ts = sent[0].headers["x-mano-timestamp"];
    expect(sent[0].headers["x-mano-signature"]).toBe(await signAgentSend(AGENT_SECRET, ts, sent[0].body));

    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(sent.length).toBe(1);
    const list = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string }[] };
    expect(list.reminders[0].status).toBe("sent");
  });

  it("a cancelled reminder never sends", async () => {
    const h = handle("rem-cancel");
    const sent = recordChannels();
    await call(h, "POST", "/reminders", { id: "turn-3:0", text: "Keep me.", dueAt: later, generation: 1 });
    await call(h, "POST", "/reminders", { id: "turn-3:1", text: "Cancel me.", dueAt: later, generation: 1 });
    const cancelled = (await (await call(h, "POST", "/reminders/turn-3:1/cancel")).json()) as { cancelled: boolean };
    expect(cancelled.cancelled).toBe(true);
    await makeDue(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(sent.map((s) => JSON.parse(s.body).key)).toEqual(["reminder:turn-3:0"]);
  });

  it("a Channels outage retries later under the same key", async () => {
    const h = handle("rem-retry");
    const sent = recordChannels(() => new Response("down", { status: 500 }));
    await call(h, "POST", "/reminders", { id: "turn-4:0", text: "Retry me.", dueAt: later, generation: 1 });
    await makeDue(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    const waiting = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string; attempts: number }[] };
    expect(waiting.reminders[0]).toMatchObject({ status: "scheduled", attempts: 1 });
    expect(sent.length).toBe(1);
  });
});

describe("turn ledger", () => {
  it("keeps the first receive time for a retried turn", async () => {
    const h = handle("turns");
    const first = await call(h, "POST", "/turns", { turnId: "t-100", receivedAt: "2026-11-01T15:00:00.000Z" });
    expect(first.status).toBe(201);
    const retry = await call(h, "POST", "/turns", { turnId: "t-100", receivedAt: "2026-11-01T15:05:00.000Z" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { turn: { firstReceivedAt: string } }).turn.firstReceivedAt).toBe("2026-11-01T15:00:00.000Z");
    const done = (await (await call(h, "POST", "/turns/t-100/complete")).json()) as { turn: { status: string } };
    expect(done.turn.status).toBe("complete");
    expect((await call(h, "GET", "/turns/t-404")).status).toBe(404);
  });
});

async function pendingApproval(h: string): Promise<string> {
  const res = await call(h, "POST", "/action", {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `as-${crypto.randomUUID()}`,
    actor: "foreground",
    sources: [],
    origin: "person",
  });
  return ((await res.json()) as { approval: { id: string } }).approval.id;
}

describe("pending approval pointer", () => {
  it("reads as nothing under a different generation", async () => {
    const h = handle("pointer");
    const approvalId = await pendingApproval(h);
    expect((await call(h, "PUT", "/pending-approval", { approvalId, generation: 2 })).status).toBe(200);
    const same = (await (await call(h, "GET", "/pending-approval?generation=2")).json()) as { pointer: { approvalId: string } | null };
    expect(same.pointer?.approvalId).toBe(approvalId);
    const other = (await (await call(h, "GET", "/pending-approval?generation=3")).json()) as { pointer: unknown };
    expect(other.pointer).toBeNull();
    expect((await call(h, "PUT", "/pending-approval", { approvalId: crypto.randomUUID(), generation: 2 })).status).toBe(404);
    expect(await (await call(h, "DELETE", "/pending-approval")).json()).toEqual({ cleared: true });
    expect((await (await call(h, "GET", "/pending-approval?generation=2")).json()) as unknown).toEqual({ pointer: null });
  });
});

describe("conversation delete", () => {
  it("Channels removes everything and the answer says exactly what", async () => {
    const h = handle("delete-all");
    recordChannels();
    await call(h, "POST", "/reminders", { id: "d:0", text: "One.", dueAt: "2026-12-01T15:00:00.000Z", generation: 1 });
    await call(h, "POST", "/reminders", { id: "d:1", text: "Two.", dueAt: "2026-12-01T15:00:00.000Z", generation: 1 });
    await call(h, "POST", "/turns", { turnId: "t-1", receivedAt: "2026-11-01T15:00:00.000Z" });
    const approvalId = await pendingApproval(h);
    await call(h, "PUT", "/pending-approval", { approvalId, generation: 1 });
    await call(h, "POST", "/memory", { content: "Has two kids.", source: "text" });
    await call(h, "POST", "/memory", { content: "Prefers texts.", source: "text" });

    expect((await call(h, "GET", "/reminders", undefined, { token: CHANNELS_TOKEN })).status).toBe(403);
    const res = await call(h, "DELETE", "/conversation", undefined, { token: CHANNELS_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      removed: { remindersCancelled: 2, turnsDeleted: 1, pendingPointerCleared: true, approvalsRejected: 1, memoriesDeleted: 2 },
    });

    const reminders = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string }[] };
    expect(reminders.reminders.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect((await call(h, "GET", "/turns/t-1")).status).toBe(404);
    const approvals = (await (await call(h, "GET", "/approvals")).json()) as { approvals: { id: string; status: string }[] };
    expect(approvals.approvals.find((a) => a.id === approvalId)?.status).toBe("rejected");
    expect(((await (await call(h, "GET", "/memory")).json()) as { memories: unknown[] }).memories).toEqual([]);
    const again = (await (await call(h, "DELETE", "/conversation")).json()) as { removed: Record<string, unknown> };
    expect(again.removed).toEqual({
      remindersCancelled: 0,
      turnsDeleted: 0,
      pendingPointerCleared: false,
      approvalsRejected: 0,
      memoriesDeleted: 0,
    });
  });
});

describe("scope", () => {
  it("refuses cross-person and session callers on the state routes", async () => {
    const a = handle("scope-a");
    const b = handle("scope-b");
    for (const [method, path] of [
      ["GET", "/reminders"],
      ["POST", "/reminders"],
      ["POST", "/reminders/x/cancel"],
      ["POST", "/turns"],
      ["GET", "/turns/x"],
      ["GET", "/pending-approval?generation=0"],
      ["PUT", "/pending-approval"],
      ["DELETE", "/conversation"],
    ] as const) {
      const body = method === "POST" || method === "PUT" ? {} : undefined;
      expect((await call(b, method, path, body, { grantFor: a })).status, `${method} ${path} with A's grant on B`).toBe(403);
      expect((await call(b, method, path, body, { grantFor: a, token: CHANNELS_TOKEN })).status, `${method} ${path} as Channels`).toBe(
        403,
      );
    }
    const session = await mintSessionToken({ kind: "person", sub: personIdForHandle(a) }, SESSION_SECRET);
    const viaSession = await SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(a)}/reminders`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(viaSession.status).toBe(404);
  });
});
