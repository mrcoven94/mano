import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle, verifyEngineSend } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// The agent's per-person state through the real worker and PersonAgent:
// reminders delivered by the alarm through Channels' agent-send route,
// the turn ledger, the generation-checked pending approval pointer, and
// the conversation delete Channels or the agent can call.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const ENGINE_SEND_SECRET = "test-engine-send-secret-not-real";
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
    const r = { id: "turn-1:0", text: "Call the county about the renewal.", dueAt: "2026-12-01T15:00:00.000Z", generation: 0 };
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
    // Channels' conversation is at generation 5: it moved Engine there.
    await call(h, "DELETE", "/conversation", { generation: 5 }, { token: CHANNELS_TOKEN });
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
    const verified = await verifyEngineSend(
      ENGINE_SEND_SECRET,
      {
        method: "POST",
        path: new URL(sent[0].url).pathname,
        timestamp: sent[0].headers["x-mano-engine-timestamp"],
        signature: sent[0].headers["x-mano-engine-signature"],
        body: sent[0].body,
      },
      Math.floor(Date.now() / 1000),
    );
    expect(verified).toEqual({ ok: true });

    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(sent.length).toBe(1);
    const list = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string }[] };
    expect(list.reminders[0].status).toBe("sent");
  });

  it("a cancelled reminder never sends", async () => {
    const h = handle("rem-cancel");
    const sent = recordChannels();
    await call(h, "POST", "/reminders", { id: "turn-3:0", text: "Keep me.", dueAt: later, generation: 0 });
    await call(h, "POST", "/reminders", { id: "turn-3:1", text: "Cancel me.", dueAt: later, generation: 0 });
    const cancelled = (await (await call(h, "POST", "/reminders/turn-3:1/cancel")).json()) as { cancelled: boolean };
    expect(cancelled.cancelled).toBe(true);
    await makeDue(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(sent.map((s) => JSON.parse(s.body).key)).toEqual(["reminder:turn-3:0"]);
  });

  it("a Channels outage retries later under the same key", async () => {
    const h = handle("rem-retry");
    const sent = recordChannels(() => new Response("down", { status: 500 }));
    await call(h, "POST", "/reminders", { id: "turn-4:0", text: "Retry me.", dueAt: later, generation: 0 });
    await makeDue(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    const waiting = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string; attempts: number }[] };
    // Handed off once, so it waits to re-send as sending, never cancellable.
    expect(waiting.reminders[0]).toMatchObject({ status: "sending", attempts: 1 });
    expect(sent.length).toBe(1);
  });
});

describe("turn ledger", () => {
  it("keeps the first receive time for a retried turn", async () => {
    const h = handle("turns");
    const first = await call(h, "POST", "/turns", { turnId: "t-100", receivedAt: "2026-11-01T15:00:00.000Z", generation: 0 });
    expect(first.status).toBe(201);
    const retry = await call(h, "POST", "/turns", { turnId: "t-100", receivedAt: "2026-11-01T15:05:00.000Z", generation: 0 });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { turn: { firstReceivedAt: string } }).turn.firstReceivedAt).toBe("2026-11-01T15:00:00.000Z");
    const done = (await (await call(h, "POST", "/turns/t-100/complete", { generation: 0 })).json()) as { turn: { status: string } };
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
    generation: 0,
  });
  return ((await res.json()) as { approval: { id: string } }).approval.id;
}

describe("pending approval pointer", () => {
  it("reads as nothing under a different generation", async () => {
    const h = handle("pointer");
    const approvalId = await pendingApproval(h);
    expect((await call(h, "PUT", "/pending-approval", { approvalId, generation: 0 })).status).toBe(200);
    const same = (await (await call(h, "GET", "/pending-approval?generation=0")).json()) as { pointer: { approvalId: string } | null };
    expect(same.pointer?.approvalId).toBe(approvalId);
    const other = (await (await call(h, "GET", "/pending-approval?generation=1")).json()) as { pointer: unknown };
    expect(other.pointer).toBeNull();
    expect((await call(h, "PUT", "/pending-approval", { approvalId: crypto.randomUUID(), generation: 0 })).status).toBe(404);
    expect(await (await call(h, "DELETE", "/pending-approval", { approvalId: crypto.randomUUID(), generation: 0 })).json()).toEqual({
      cleared: false,
    });
    expect(await (await call(h, "DELETE", "/pending-approval", { approvalId, generation: 0 })).json()).toEqual({ cleared: true });
    expect((await (await call(h, "GET", "/pending-approval?generation=0")).json()) as unknown).toEqual({ pointer: null });
  });
});

describe("conversation delete", () => {
  it("Channels removes everything and the answer says exactly what", async () => {
    const h = handle("delete-all");
    recordChannels();
    await call(h, "POST", "/reminders", { id: "d:0", text: "One.", dueAt: "2026-12-01T15:00:00.000Z", generation: 0 });
    await call(h, "POST", "/reminders", { id: "d:1", text: "Two.", dueAt: "2026-12-01T15:00:00.000Z", generation: 0 });
    await call(h, "POST", "/turns", { turnId: "t-1", receivedAt: "2026-11-01T15:00:00.000Z", generation: 0 });
    const approvalId = await pendingApproval(h);
    await call(h, "PUT", "/pending-approval", { approvalId, generation: 0 });
    await call(h, "POST", "/memory", { content: "Has two kids.", source: "text", generation: 0 });
    await call(h, "POST", "/memory", { content: "Prefers texts.", source: "text", generation: 0 });

    expect((await call(h, "GET", "/reminders", undefined, { token: CHANNELS_TOKEN })).status).toBe(403);
    expect((await call(h, "DELETE", "/conversation", undefined, { token: CHANNELS_TOKEN })).status).toBe(400);
    const res = await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      removed: {
        generation: 1,
        remindersCancelled: 2,
        remindersInFlight: 0,
        turnsDeleted: 1,
        pendingPointerCleared: true,
        approvalsRejected: 1,
        approvalsRevoked: 0,
        memoriesDeleted: 2,
      },
    });

    const reminders = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string }[] };
    expect(reminders.reminders.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect((await call(h, "GET", "/turns/t-1")).status).toBe(404);
    const approvals = (await (await call(h, "GET", "/approvals")).json()) as { approvals: { id: string; status: string }[] };
    expect(approvals.approvals.find((a) => a.id === approvalId)?.status).toBe("rejected");
    expect(((await (await call(h, "GET", "/memory")).json()) as { memories: unknown[] }).memories).toEqual([]);
    // A retry of the same delete, after the new conversation wrote: the
    // same answer, and the new conversation's memory survives.
    expect((await call(h, "POST", "/memory", { content: "New conversation.", source: "text", generation: 1 })).status).toBe(200);
    const again = (await (await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN })).json()) as {
      removed: Record<string, unknown>;
    };
    expect(again.removed).toEqual({
      generation: 1,
      remindersCancelled: 2,
      remindersInFlight: 0,
      turnsDeleted: 1,
      pendingPointerCleared: true,
      approvalsRejected: 1,
      approvalsRevoked: 0,
      memoriesDeleted: 2,
    });
    expect(((await (await call(h, "GET", "/memory")).json()) as { memories: unknown[] }).memories.length).toBe(1);
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

async function schedulesFor(handleHash: string): Promise<{ callback: string; time: number }[]> {
  return runInDurableObject(stubFor(handleHash), async (instance) =>
    (await (instance as PersonAgent).listSchedules()).map((x) => ({ callback: x.callback, time: (x as { time: number }).time })),
  );
}

async function deliverySchedules(handleHash: string) {
  return (await schedulesFor(handleHash)).filter((x) => x.callback === "deliverDueReminders");
}

describe("delete during delivery", () => {
  it("a delete landing between two sends stops the second at its handoff", async () => {
    const h = handle("race-delete");
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).key);
      // While the first send is with Channels, Channels deletes the
      // conversation: a real request into the same agent, interleaved.
      if (sent.length === 1) {
        const del = await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN });
        expect(((await del.json()) as { removed: { remindersCancelled: number } }).removed.remindersCancelled).toBe(1);
      }
      return Response.json({ sent: true });
    });
    await call(h, "POST", "/reminders", { id: "race:0", text: "First.", dueAt: later, generation: 0 });
    await call(h, "POST", "/reminders", { id: "race:1", text: "Second.", dueAt: later, generation: 0 });
    await makeDue(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(sent).toEqual(["reminder:race:0"]);
    const list = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { id: string; status: string }[] };
    expect(Object.fromEntries(list.reminders.map((r) => [r.id, r.status]))).toEqual({ "race:0": "sent", "race:1": "cancelled" });
  });
});

describe("old turn after a delete", () => {
  it("cannot insert an approval, memory, reminder, turn or pointer under the old generation", async () => {
    const h = handle("old-turn");
    const approvalId = await pendingApproval(h);
    await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN });
    expect(((await (await call(h, "GET", "/conversation")).json()) as { generation: number }).generation).toBe(1);

    const action = await call(h, "POST", "/action", {
      type: "submit",
      recipient: "sandbox-agency",
      purpose: "renewal",
      payload: {},
      idempotencyKey: `old-${crypto.randomUUID()}`,
      actor: "foreground",
      sources: [],
      origin: "person",
      generation: 0,
    });
    expect(((await action.json()) as { reason: string }).reason).toMatch(/conversation was deleted/i);
    expect((await call(h, "POST", "/memory", { content: "Late.", source: "text", generation: 0 })).status).toBe(409);
    expect((await call(h, "POST", "/reminders", { id: "old:0", text: "Late.", dueAt: later, generation: 0 })).status).toBe(409);
    expect((await call(h, "POST", "/turns", { turnId: "t-old", receivedAt: later, generation: 0 })).status).toBe(409);
    expect((await call(h, "PUT", "/pending-approval", { approvalId, generation: 0 })).status).toBe(409);
    expect((await call(h, "POST", "/memory", { content: "No generation.", source: "text" })).status).toBe(400);

    const approvals = (await (await call(h, "GET", "/approvals")).json()) as { approvals: unknown[] };
    expect(approvals.approvals.length).toBe(1);
    expect(((await (await call(h, "GET", "/memory")).json()) as { memories: unknown[] }).memories).toEqual([]);
    expect(((await (await call(h, "GET", "/reminders")).json()) as { reminders: unknown[] }).reminders).toEqual([]);
    expect((await call(h, "POST", "/memory", { content: "Current.", source: "text", generation: 1 })).status).toBe(200);
  });
});

describe("the delivery wake-up", () => {
  it("is one schedule per person, moved to the earliest deadline", async () => {
    const h = handle("one-wakeup");
    recordChannels();
    await call(h, "POST", "/reminders", { id: "w:0", text: "Later.", dueAt: "2026-12-03T15:00:00.000Z", generation: 0 });
    await call(h, "POST", "/reminders", { id: "w:1", text: "Latest.", dueAt: "2026-12-05T15:00:00.000Z", generation: 0 });
    await call(h, "POST", "/reminders", { id: "w:2", text: "Earliest.", dueAt: "2026-12-01T15:00:00.000Z", generation: 0 });
    let wakeups = await deliverySchedules(h);
    expect(wakeups.length).toBe(1);
    expect(wakeups[0].time).toBe(Date.parse("2026-12-01T15:00:00.000Z") / 1000);
    await call(h, "POST", "/reminders/w:2/cancel");
    wakeups = await deliverySchedules(h);
    expect(wakeups.length).toBe(1);
    expect(wakeups[0].time).toBe(Date.parse("2026-12-03T15:00:00.000Z") / 1000);
    await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN });
    expect(await deliverySchedules(h)).toEqual([]);
  });

  it("a retry that finds the reminder repairs a lost wake-up, and a restart recovers it", async () => {
    const h = handle("repair-wakeup");
    recordChannels();
    const r = { id: "rep:0", text: "Repair me.", dueAt: "2026-12-01T15:00:00.000Z", generation: 0 };
    await call(h, "POST", "/reminders", r);
    const lose = () =>
      runInDurableObject(stubFor(h), async (instance) => {
        const agent = instance as PersonAgent;
        for (const x of await agent.listSchedules()) {
          if (x.callback === "deliverDueReminders") await agent.cancelSchedule(x.id);
        }
      });
    await lose();
    expect(await deliverySchedules(h)).toEqual([]);
    expect((await call(h, "POST", "/reminders", r)).status).toBe(200);
    expect((await deliverySchedules(h)).length).toBe(1);

    await lose();
    await runInDurableObject(stubFor(h), async (instance) => {
      await (instance as PersonAgent).onStart();
    });
    expect((await deliverySchedules(h)).length).toBe(1);
  });

  it("restart recovery keeps exactly one wake-up when a crash left extra schedules", async () => {
    const h = handle("crash-wakeup");
    recordChannels();
    await call(h, "POST", "/reminders", { id: "crash:0", text: "Once.", dueAt: "2026-12-01T15:00:00.000Z", generation: 0 });
    // Fault injection: a crash between creating a schedule and recording
    // it leaves an unrecorded delivery schedule, and the record is lost.
    await runInDurableObject(stubFor(h), async (instance, state) => {
      const agent = instance as PersonAgent;
      await agent.schedule(new Date("2026-12-01T15:00:00.000Z"), "deliverDueReminders", {});
      await agent.schedule(new Date("2026-12-02T15:00:00.000Z"), "deliverDueReminders", {});
      state.storage.sql.exec("DELETE FROM reminder_wakeup");
    });
    expect((await deliverySchedules(h)).length).toBe(3);
    await runInDurableObject(stubFor(h), async (instance) => {
      await (instance as PersonAgent).onStart();
    });
    const wakeups = await deliverySchedules(h);
    expect(wakeups.length).toBe(1);
    expect(wakeups[0].time).toBe(Date.parse("2026-12-01T15:00:00.000Z") / 1000);

    // With the record intact but an extra schedule beside it.
    await runInDurableObject(stubFor(h), async (instance) => {
      await (instance as PersonAgent).schedule(new Date("2026-12-03T15:00:00.000Z"), "deliverDueReminders", {});
      await (instance as PersonAgent).onStart();
    });
    expect((await deliverySchedules(h)).length).toBe(1);
  });
});

describe("a cancel after an uncertain handoff", () => {
  // Sol's reproduction: (1) a reminder is due; (2) a delivery run hands it
  // to Channels and the answer is uncertain (an outage, or the run dies
  // after the handoff); (3) the person cancels; (4) the next run. Channels
  // may already have accepted the send in step 2, so the cancel in step 3
  // must answer "already on its way", and step 4 re-sends under the same
  // key for Channels to dedupe, never reporting the reminder cancelled.
  async function dueEverything(h: string) {
    await runInDurableObject(stubFor(h), (_i, state) => {
      state.storage.sql.exec("UPDATE reminders SET next_at_ms = ?, claimed_at_ms = ? WHERE status NOT IN ('sent', 'dropped', 'failed', 'cancelled')", Date.now() - 1, 0);
    });
  }

  it("after an uncertain answer from Channels", async () => {
    const h = handle("uncertain-500");
    let up = false;
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).key);
      return up ? Response.json({ sent: true }) : new Response("upstream timeout", { status: 504 });
    });
    await call(h, "POST", "/reminders", { id: "unc:0", text: "Pick up the forms.", dueAt: later, generation: 0 });
    await makeDue(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(keys).toEqual(["reminder:unc:0"]);

    const cancel = (await (await call(h, "POST", "/reminders/unc:0/cancel")).json()) as {
      cancelled: boolean;
      reason?: string;
      reminder: { status: string };
    };
    expect(cancel.cancelled).toBe(false);
    expect(cancel.reason).toBe("already on its way");
    expect(cancel.reminder.status).toBe("sending");

    up = true;
    await dueEverything(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(keys).toEqual(["reminder:unc:0", "reminder:unc:0"]);
    const list = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { status: string }[] };
    expect(list.reminders[0].status).toBe("sent");
  });

  it("after a delivery run dies between the handoff and the answer", async () => {
    const h = handle("uncertain-crash");
    const keys: string[] = [];
    const lateCancels: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(JSON.parse(String(init?.body)).key);
      // While recovery re-sends the first, the person cancels the second:
      // a real request interleaved into the same agent mid-run.
      if (keys.length === 1) lateCancels.push(await (await call(h, "POST", "/reminders/crash:1/cancel")).json());
      return Response.json({ sent: true });
    });
    await call(h, "POST", "/reminders", { id: "crash:0", text: "Bring the pay stub.", dueAt: later, generation: 0 });
    await call(h, "POST", "/reminders", { id: "crash:1", text: "Bring the ID.", dueAt: later, generation: 0 });
    await makeDue(h);
    // The run claims and hands off both, then dies before Channels answers.
    await runInDurableObject(stubFor(h), async (_i, state) => {
      const { claimDueReminders, handOffReminder } = await import("../src/agents/agent-state.js");
      claimDueReminders(state.storage.sql, Date.now(), 120_000, "dead-run", 25);
      expect(handOffReminder(state.storage.sql, "crash:0", "dead-run", Date.now())).toBe(true);
      expect(handOffReminder(state.storage.sql, "crash:1", "dead-run", Date.now())).toBe(true);
    });

    const cancel = (await (await call(h, "POST", "/reminders/crash:0/cancel")).json()) as { cancelled: boolean; reason?: string };
    expect(cancel).toMatchObject({ cancelled: false, reason: "already on its way" });

    // The lease runs out; recovery re-sends both under their keys.
    await dueEverything(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(lateCancels).toEqual([expect.objectContaining({ cancelled: false, reason: "already on its way" })]);
    expect(keys).toEqual(["reminder:crash:0", "reminder:crash:1"]);
    const list = (await (await call(h, "GET", "/reminders")).json()) as { reminders: { id: string; status: string }[] };
    expect(Object.fromEntries(list.reminders.map((r) => [r.id, r.status]))).toEqual({ "crash:0": "sent", "crash:1": "sent" });
  });
});
