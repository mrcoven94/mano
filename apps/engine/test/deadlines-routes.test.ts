import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Deadlines through the real worker and PersonAgent: the contract routes,
// nudges delivered by the alarm itself through Channels' agent-send
// route, STOP and quiet hours, and a delivery run that dies after the
// handoff, recovered once after a restart.

const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const SESSION_SECRET = "test-session-secret-not-real";

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(handleHash: string, method: string, path: string, body?: unknown, opts: { token?: string } = {}) {
  const grant = await mintHandleGrant(handleHash, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(handleHash)}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.token ?? AGENT_TOKEN}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Channels as Engine sees it: agent-send answers, recorded with the key
// it was sent under. Repeating a key Channels already sent answers
// duplicate and delivers nothing, as Channels' own dedupe does.
function recordChannels(answer: (key: string) => Response | Promise<Response> = () => Response.json({ sent: true })) {
  const delivered: { key: string; text: string; generation: number }[] = [];
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { key: string; text: string; generation: number };
    posts.push(body.key);
    if (delivered.some((d) => d.key === body.key)) return Response.json({ sent: true, duplicate: true });
    const res = await answer(body.key);
    if (res.status === 200) {
      const copy = (await res.clone().json()) as { sent?: boolean };
      if (copy.sent === true) delivered.push(body);
    }
    return res;
  });
  return { delivered, posts };
}

function stubFor(handleHash: string) {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(personIdForHandle(handleHash)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

async function firstNudgeStatus(h: string): Promise<string> {
  const list = (await (await call(h, "GET", "/deadlines")).json()) as Listed;
  return list.deadlines[0].nudges[0].status;
}

// The alarm's run settles the nudge after Channels answers.
const settled = (h: string) => until(async () => !["scheduled", "claimed", "sending"].includes(await firstNudgeStatus(h)));

// A date this many days from today, UTC calendar.
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const renewal = (over: Record<string, unknown> = {}) => ({
  title: "CalFresh renewal",
  dueDate: inDays(30),
  program: "CalFresh",
  source: { kind: "letter", documentId: "doc-1", sentence: "Return your renewal form by the date above." },
  idempotencyKey: "letter:doc-1:renewal",
  ...over,
});

type Listed = {
  deadlines: { id: string; status: string; dueDate: string; nudges: { reminderId: string; daysBefore: number; status: string; text: string }[] }[];
};

// Time passing, in SQL: the earliest waiting nudge of this person becomes
// due now, inside its quiet-hours window, and the wake-up moves to it.
async function makeFirstNudgeDue(h: string) {
  await runInDurableObject(stubFor(h), async (instance, state) => {
    const sql = state.storage.sql;
    const row = sql
      .exec("SELECT n.reminder_id AS id FROM deadline_nudges n JOIN reminders r ON r.id = n.reminder_id WHERE r.status = 'scheduled' ORDER BY r.next_at_ms LIMIT 1")
      .toArray()[0] as { id: string };
    sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", Date.now() - 1, row.id);
    sql.exec("UPDATE deadline_nudges SET window_start_ms = ?, window_end_ms = ? WHERE reminder_id = ?", Date.now() - 60_000, Date.now() + 3_600_000, row.id);
    await (instance as PersonAgent).armReminderWakeup();
  });
}

describe("the deadlines contract", () => {
  it("POST creates, the same key is the same deadline, GET lists it with its nudges, DELETE cancels", async () => {
    const h = handle("dl-contract");
    recordChannels();
    const created = await call(h, "POST", "/deadlines", renewal());
    expect(created.status).toBe(201);
    const body = (await created.json()) as { status: string; deadline: { id: string; nudges: unknown[] } };
    expect(body.status).toBe("created");
    expect(body.deadline.nudges).toHaveLength(4);

    const again = await call(h, "POST", "/deadlines", renewal());
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe("existing");

    const list = (await (await call(h, "GET", "/deadlines")).json()) as Listed;
    expect(list.deadlines.map((d) => d.id)).toEqual([body.deadline.id]);

    const cancelled = await call(h, "DELETE", `/deadlines/${body.deadline.id}`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled", deadline: { status: "cancelled" } });
    expect((await call(h, "DELETE", "/deadlines/dl-0000")).status).toBe(404);
    expect((await call(h, "POST", "/deadlines", { ...renewal(), dueDate: "next week" })).status).toBe(400);
  });

  it("a moved date answers moved with both dates", async () => {
    const h = handle("dl-moved");
    recordChannels();
    await call(h, "POST", "/deadlines", renewal());
    const moved = await call(h, "POST", "/deadlines", renewal({ dueDate: inDays(40) }));
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ status: "moved", moved: { from: inDays(30), to: inDays(40) } });
  });

  it("the person's own session reads and closes them; another person's grant cannot", async () => {
    const h = handle("dl-session");
    recordChannels();
    const created = (await (await call(h, "POST", "/deadlines", renewal())).json()) as { deadline: { id: string } };
    const token = await mintSessionToken({ kind: "person", sub: personIdForHandle(h) }, SESSION_SECRET);
    const own = await SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(h)}/deadlines`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(own.status).toBe(200);
    const done = await SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(h)}/deadlines/${created.deadline.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(await done.json()).toMatchObject({ status: "done" });
    const other = handle("dl-other");
    const grant = await mintHandleGrant(other, GRANT_SECRET);
    const cross = await SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(h)}/deadlines`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-mano-handle-grant": grant },
    });
    expect(cross.status).toBe(403);
    // Channels' token opens only the conversation delete.
    expect((await call(h, "GET", "/deadlines", undefined, { token: CHANNELS_TOKEN })).status).toBe(403);
  });
});

describe("nudges go out by themselves", () => {
  it("the alarm delivers the first nudge once, with the exact text, under its key and generation", async () => {
    const h = handle("dl-alarm");
    const channels = recordChannels();
    await call(h, "DELETE", "/conversation", { generation: 3 }, { token: CHANNELS_TOKEN });
    await call(h, "POST", "/deadlines", renewal({ dueDate: inDays(14) }));
    await makeFirstNudgeDue(h);
    await until(() => channels.delivered.length > 0);
    expect(channels.delivered).toHaveLength(1);
    expect(channels.delivered[0]).toMatchObject({ generation: 3 });
    expect(channels.delivered[0].key).toMatch(/^reminder:nudge:dl-[0-9a-f]{32}:0:1[34]$/);
    expect(channels.delivered[0].text).toMatch(/^Your CalFresh renewal is due in 1[34] days, on [A-Z][a-z]+ \d{1,2}\. Want me to start it\?$/);
    await settled(h);
    expect(await firstNudgeStatus(h)).toBe("sent");
    // A nudge is the deadline's, not a reminder the person set.
    const reminders = (await (await call(h, "GET", "/reminders")).json()) as { reminders: unknown[] };
    expect(reminders.reminders).toEqual([]);
  });

  it("after STOP, Channels refuses and the nudge is dropped, never retried", async () => {
    const h = handle("dl-stop");
    const channels = recordChannels(() => Response.json({ sent: false, reason: "opted_out" }));
    await call(h, "POST", "/deadlines", renewal({ dueDate: inDays(20) }));
    await makeFirstNudgeDue(h);
    await until(() => channels.posts.length > 0);
    await settled(h);
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(channels.posts).toHaveLength(1);
    expect(channels.delivered).toEqual([]);
    expect(await firstNudgeStatus(h)).toBe("dropped");
  });

  it("a nudge whose day ended before it could go is dropped, not sent late", async () => {
    const h = handle("dl-quiet");
    const channels = recordChannels();
    await call(h, "POST", "/deadlines", renewal({ dueDate: inDays(20) }));
    await runInDurableObject(stubFor(h), async (instance, state) => {
      const sql = state.storage.sql;
      const row = sql.exec("SELECT reminder_id AS id FROM deadline_nudges ORDER BY days_before DESC LIMIT 1").toArray()[0] as { id: string };
      sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", Date.now() - 1, row.id);
      // Its 9:00 to 20:00 window closed an hour ago.
      sql.exec("UPDATE deadline_nudges SET window_start_ms = ?, window_end_ms = ? WHERE reminder_id = ?", Date.now() - 12 * 3_600_000, Date.now() - 3_600_000, row.id);
      await (instance as PersonAgent).deliverDueReminders();
    });
    expect(channels.posts).toEqual([]);
    const list = (await (await call(h, "GET", "/deadlines")).json()) as Listed;
    expect(list.deadlines[0].nudges.map((n) => n.status)).toEqual(["dropped", "scheduled", "scheduled", "scheduled"]);
  });

  it("done after the letter stops every nudge before it goes", async () => {
    const h = handle("dl-done");
    const channels = recordChannels();
    const created = (await (await call(h, "POST", "/deadlines", renewal({ dueDate: inDays(20) }))).json()) as { deadline: { id: string } };
    await call(h, "PATCH", `/deadlines/${created.deadline.id}`, { status: "done" });
    await runInDurableObject(stubFor(h), async (instance, state) => {
      state.storage.sql.exec("UPDATE reminders SET next_at_ms = ?", Date.now() - 1);
      await (instance as PersonAgent).deliverDueReminders();
    });
    expect(channels.posts).toEqual([]);
  });
});

describe("restart reconciliation", () => {
  it("a run that dies after the handoff is recovered after a restart and delivered exactly once", async () => {
    const h = handle("dl-restart");
    const channels = recordChannels();
    await call(h, "POST", "/deadlines", renewal({ dueDate: inDays(20) }));
    // The dead run: claimed and handed off, Channels got it, no answer.
    let nudgeId = "";
    await runInDurableObject(stubFor(h), async (_i, state) => {
      const sql = state.storage.sql;
      const { claimDueReminders, handOffReminder } = await import("../src/agents/agent-state.js");
      const row = sql.exec("SELECT reminder_id AS id FROM deadline_nudges ORDER BY days_before DESC LIMIT 1").toArray()[0] as { id: string };
      nudgeId = row.id;
      sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", Date.now() - 1, nudgeId);
      sql.exec("UPDATE deadline_nudges SET window_start_ms = ?, window_end_ms = ? WHERE reminder_id = ?", Date.now() - 60_000, Date.now() + 3_600_000, nudgeId);
      const [claimed] = claimDueReminders(sql, Date.now(), 120_000, "dead-run", 25);
      expect(claimed.id).toBe(nudgeId);
      expect(handOffReminder(sql, nudgeId, "dead-run", Date.now())).toBe(true);
    });
    // What Channels saw from the dead run: the send, recorded as delivered.
    channels.delivered.push({ key: `reminder:${nudgeId}`, text: "(from the dead run)", generation: 0 });
    // The restart: the lease ran out, the agent starts and re-arms its one
    // wake-up from the table, and the alarm fires on its own.
    await runInDurableObject(stubFor(h), async (instance, state) => {
      state.storage.sql.exec("UPDATE reminders SET claimed_at_ms = ? WHERE id = ?", 0, nudgeId);
      await (instance as PersonAgent).onStart();
    });
    await until(() => channels.posts.length > 0);
    // Re-sent under the same key, so Channels answered duplicate: one text.
    expect(channels.posts).toEqual([`reminder:${nudgeId}`]);
    expect(channels.delivered).toHaveLength(1);
    await settled(h);
    expect(await firstNudgeStatus(h)).toBe("sent");
    // And it never goes again.
    await (stubFor(h) as unknown as PersonAgent).deliverDueReminders();
    expect(channels.posts).toHaveLength(1);
  });
});

describe("conversation delete", () => {
  it("removes the person's deadlines, and a retried old delete never removes newer ones", async () => {
    const h = handle("dl-delete");
    recordChannels();
    await call(h, "POST", "/deadlines", renewal());
    await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN });
    expect(((await (await call(h, "GET", "/deadlines")).json()) as Listed).deadlines).toEqual([]);
    await call(h, "POST", "/deadlines", renewal({ idempotencyKey: "letter:doc-2:renewal" }));
    await call(h, "DELETE", "/conversation", { generation: 1 }, { token: CHANNELS_TOKEN });
    expect(((await (await call(h, "GET", "/deadlines")).json()) as Listed).deadlines).toHaveLength(1);
  });
});
