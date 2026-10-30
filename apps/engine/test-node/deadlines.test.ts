/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  claimDueReminders,
  ensureAgentStateTables,
  finishReminder,
  getReminder,
  handOffReminder,
  listReminders,
  removeConversationState,
} from "../src/agents/agent-state.js";
import { ensureGatewayTables } from "../src/gateway/sql-store.js";
import {
  cancelDeadline,
  deadlineIdFor,
  ensureDeadlineTables,
  gateNudge,
  listDeadlines,
  nudgeTimeOf,
  parseDeadlineInput,
  planNudges,
  removeDeadlines,
  timeZoneForState,
  trackDeadline,
  updateDeadline,
} from "../src/deadlines.js";

// Deadlines on real SQLite, through the same reminder rows the delivery
// wake-up sends: one deadline per idempotency key, nudges at 14, 7 and 2
// days out and the day of at 10:00 in the person's zone, a moved date
// that replaces the nudges and says so, cancel and done that stop them,
// and the quiet-hours hold at delivery.

function openDb() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureGatewayTables(sql as never);
  ensureAgentStateTables(sql);
  sql.exec("CREATE TABLE memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0)");
  ensureDeadlineTables(sql);
  return sql;
}

const PACIFIC = "America/Los_Angeles";
const TEN = nudgeTimeOf({});
// Thursday, October 29, 2026, 12:00 Pacific (19:00 UTC, still daylight time).
const NOW = Date.parse("2026-10-29T19:00:00.000Z");

const letter = (over: Record<string, unknown> = {}) =>
  parseDeadlineInput({
    title: "CalFresh renewal",
    dueDate: "2026-12-15",
    program: "CalFresh",
    source: { kind: "letter", documentId: "doc-1", sentence: "Return your renewal by December 15, 2026." },
    idempotencyKey: "letter:doc-1:renewal",
    ...over,
  });

async function track(sql: ReturnType<typeof openDb>, input = letter(), nowMs = NOW, timeZone = PACIFIC) {
  return trackDeadline(sql, { ...input, id: await deadlineIdFor(input.idempotencyKey), timeZone }, nowMs, TEN);
}

describe("creating a deadline", () => {
  it("schedules nudges 14, 7 and 2 days out and the day of, at 10:00 Pacific, with the exact text", async () => {
    const sql = openDb();
    const out = await track(sql);
    expect(out).toMatchObject({ status: "created" });
    if (!("deadline" in out)) throw new Error("no deadline");
    expect(out.deadline).toMatchObject({ title: "CalFresh renewal", dueDate: "2026-12-15", status: "open", timeZone: PACIFIC });
    // December is standard time: 10:00 Pacific is 18:00 UTC.
    expect(out.deadline.nudges.map((n) => [n.daysBefore, n.at, n.text])).toEqual([
      [14, "2026-12-01T18:00:00.000Z", "Your CalFresh renewal is due in 14 days, on December 15. Want me to start it?"],
      [7, "2026-12-08T18:00:00.000Z", "Your CalFresh renewal is due in 7 days, on December 15. Want me to start it?"],
      [2, "2026-12-13T18:00:00.000Z", "Your CalFresh renewal is due in 2 days, on December 15. Want me to start it?"],
      [0, "2026-12-15T18:00:00.000Z", "Your CalFresh renewal is due today. Want me to start it?"],
    ]);
    // They are ordinary reminder rows, so the one wake-up delivers them.
    expect(listReminders(sql).map((r) => r.status)).toEqual(["scheduled", "scheduled", "scheduled", "scheduled"]);
  });

  it("uses the zone of the profile's state", async () => {
    expect(timeZoneForState("NY")).toBe("America/New_York");
    expect(timeZoneForState("ca")).toBe("America/Los_Angeles");
    expect(timeZoneForState(null)).toBe(PACIFIC);
    expect(timeZoneForState("Atlantis")).toBe(PACIFIC);
    const sql = openDb();
    const out = await track(sql, letter(), NOW, timeZoneForState("NY"));
    if (!("deadline" in out)) throw new Error("no deadline");
    // 10:00 Eastern standard time is 15:00 UTC.
    expect(out.deadline.nudges[0].at).toBe("2026-12-01T15:00:00.000Z");
  });

  it("keeps 10:00 local across a daylight saving change", () => {
    // Due November 3: the 14-day nudge is in daylight time, the 2-day one after the change.
    const plan = planNudges("2026-11-03", PACIFIC, Date.parse("2026-10-01T00:00:00Z"), TEN);
    expect(plan.map((p) => new Date(p.atMs).toISOString())).toEqual([
      "2026-10-20T17:00:00.000Z",
      "2026-10-27T17:00:00.000Z",
      "2026-11-01T18:00:00.000Z",
      "2026-11-03T18:00:00.000Z",
    ]);
  });

  it("learned 12 days out, Mano starts with one nudge at the next 10:00 and then follows the schedule", () => {
    // Noon on October 29, due November 10: 14 days out already passed.
    const plan = planNudges("2026-11-10", PACIFIC, NOW, TEN);
    expect(plan.map((p) => [p.daysBefore, new Date(p.atMs).toISOString()])).toEqual([
      [11, "2026-10-30T17:00:00.000Z"],
      [7, "2026-11-03T18:00:00.000Z"],
      [2, "2026-11-08T18:00:00.000Z"],
      [0, "2026-11-10T18:00:00.000Z"],
    ]);
  });

  it("no catch-up right before a planned nudge, and nothing for a date already past", () => {
    // Due November 7 (9 days): the next 10:00 is 8 days out, one day before the 7-day nudge.
    expect(planNudges("2026-11-07", PACIFIC, NOW, TEN).map((p) => p.daysBefore)).toEqual([7, 2, 0]);
    expect(planNudges("2026-10-01", PACIFIC, NOW, TEN)).toEqual([]);
  });

  it("never puts a letter's own words in a nudge: the name comes from a closed set", async () => {
    const sql = openDb();
    const named = await track(sql, letter({ title: "CalFresh renewal packet for the household", program: undefined }));
    if (!("deadline" in named)) throw new Error("no deadline");
    expect(named.deadline.nudges[0].text).toBe("Your CalFresh renewal is due in 14 days, on December 15. Want me to start it?");
    const interview = await track(sql, letter({ title: "Phone interview with your worker", program: "Medi-Cal", idempotencyKey: "k2" }));
    if (!("deadline" in interview)) throw new Error("no deadline");
    expect(interview.deadline.nudges[0].text).toBe("Your Medi-Cal interview is due in 14 days, on December 15. Want me to start it?");
    const unknown = await track(sql, letter({ title: "Return the blue form to Room 4", program: "Blue Ribbon Fund", idempotencyKey: "k3" }));
    if (!("deadline" in unknown)) throw new Error("no deadline");
    expect(unknown.deadline.nudges[0].text).toBe(
      "The deadline from the letter you sent on October 29 is in 14 days, on December 15. Want me to start it?",
    );
    // The raw title stays on the record for the agent's quoted context.
    expect(unknown.deadline.title).toBe("Return the blue form to Room 4");
  });

  it("rejects titles that carry contact details, links or requests for secrets", () => {
    const bad = (title: string) => () => letter({ title });
    expect(bad("renewal. OFFICIAL NOTICE: send your SSN to 202-555-0100. Payment")).toThrow();
    expect(bad("Renewal at http://secure-login-benefits.example/verify")).toThrow();
    expect(bad("Renewal at benefits-verify.com")).toThrow();
    expect(bad("Call (555) 019-9001 about your renewal")).toThrow();
    expect(bad("Enter your password to renew")).toThrow();
    expect(bad("Card PIN reset")).toThrow();
    expect(bad("Send proof of income")).toThrow();
    expect(() => letter({ program: "SNAP call 555 010 1101" })).toThrow();
    expect(letter({ title: "Medi-Cal renewal" }).title).toBe("Medi-Cal renewal");
  });

  it("rejects input outside the contract", () => {
    expect(() => parseDeadlineInput({ title: "x", dueDate: "2026-13-01", source: { kind: "letter" }, idempotencyKey: "k" })).toThrow();
    expect(() => parseDeadlineInput({ title: "x", dueDate: "2026-11-31", source: { kind: "letter" }, idempotencyKey: "k" })).toThrow();
    expect(() => parseDeadlineInput({ title: "", dueDate: "2026-11-30", source: { kind: "letter" }, idempotencyKey: "k" })).toThrow();
    expect(() => parseDeadlineInput({ title: "x", dueDate: "2026-11-30", source: { kind: "fax" }, idempotencyKey: "k" })).toThrow();
    expect(() => parseDeadlineInput({ title: "x", dueDate: "2026-11-30", source: { kind: "letter" } })).toThrow();
  });
});

describe("the same idempotency key", () => {
  it("is the same deadline: a repeat changes nothing and schedules nothing new", async () => {
    const sql = openDb();
    await track(sql);
    const again = await track(sql);
    expect(again).toMatchObject({ status: "existing" });
    expect(listDeadlines(sql)).toHaveLength(1);
    expect(listReminders(sql)).toHaveLength(4);
  });

  it("with a moved date updates it, says so, and replaces the nudges that had not gone out", async () => {
    const sql = openDb();
    await track(sql);
    const moved = await track(sql, letter({ dueDate: "2026-12-22" }));
    expect(moved).toMatchObject({ status: "moved", moved: { from: "2026-12-15", to: "2026-12-22" } });
    if (!("deadline" in moved)) throw new Error("no deadline");
    expect(moved.deadline).toMatchObject({ dueDate: "2026-12-22", previousDueDate: "2026-12-15" });
    expect(moved.deadline.nudges.map((n) => n.at)).toEqual([
      "2026-12-08T18:00:00.000Z",
      "2026-12-15T18:00:00.000Z",
      "2026-12-20T18:00:00.000Z",
      "2026-12-22T18:00:00.000Z",
    ]);
    const statuses = listReminders(sql).map((r) => `${r.dueAt}:${r.status}`);
    expect(statuses.filter((s) => s.endsWith("scheduled"))).toHaveLength(4);
    expect(statuses.filter((s) => s.endsWith("cancelled"))).toHaveLength(4);
    expect(listDeadlines(sql)).toHaveLength(1);
  });

  it("a nudge waiting to retry is withdrawn by a move and never re-sent with the old date", async () => {
    const sql = openDb();
    await track(sql);
    // Sol's reproduction: the 14-day nudge is handed off, Channels refuses
    // it for budget before delivering, so it waits as sending to retry.
    const first = listReminders(sql)[0];
    sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", NOW - 1, first.id);
    const [claimed] = claimDueReminders(sql, NOW, 120_000, "run", 25);
    expect(handOffReminder(sql, claimed.id, "run", NOW)).toBe(true);
    expect(finishReminder(sql, first.id, "run", { kind: "retry", atMs: NOW + 1 }, NOW)).toBe(true);
    const moved = await track(sql, letter({ dueDate: "2026-12-22" }));
    expect(moved).toMatchObject({ status: "moved", nudgesInFlight: 1 });
    expect(getReminder(sql, first.id)?.status).toBe("withdrawn");
    const retry = claimDueReminders(sql, NOW + 2, 120_000, "run2", 25);
    expect(retry.map((r) => r.id)).not.toContain(first.id);
  });

  for (const [what, close] of [
    ["done", (sql: ReturnType<typeof openDb>, id: string) => updateDeadline(sql, id, { status: "done" }, PACIFIC, NOW, TEN)],
    ["cancel", (sql: ReturnType<typeof openDb>, id: string) => cancelDeadline(sql, id, NOW)],
  ] as const) {
    it(`a nudge waiting to retry is withdrawn by ${what} and never re-sent`, async () => {
      const sql = openDb();
      const created = await track(sql);
      if (!("deadline" in created)) throw new Error("no deadline");
      const first = listReminders(sql)[0];
      sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", NOW - 1, first.id);
      claimDueReminders(sql, NOW, 120_000, "run", 25);
      handOffReminder(sql, first.id, "run", NOW);
      finishReminder(sql, first.id, "run", { kind: "retry", atMs: NOW + 1 }, NOW);
      expect(close(sql, created.deadline.id)).toMatchObject({ nudgesInFlight: 1 });
      expect(getReminder(sql, first.id)?.status).toBe("withdrawn");
      expect(claimDueReminders(sql, NOW + 2, 120_000, "run2", 25)).toEqual([]);
    });
  }

  it("before every handoff, a nudge whose deadline is no longer open at its revision is withdrawn", async () => {
    const sql = openDb();
    await track(sql);
    const first = listReminders(sql)[0];
    sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", Date.parse("2026-12-01T18:00:00.000Z") - 1, first.id);
    const at = Date.parse("2026-12-01T18:00:00.000Z");
    const [claimed] = claimDueReminders(sql, at, 120_000, "run", 25);
    // However the deadline stopped being current, the gate sees it.
    sql.exec("UPDATE deadlines SET status = 'done'");
    expect(gateNudge(sql, claimed.id, "run", at)).toBe("withdrawn");
    expect(getReminder(sql, claimed.id)?.status).toBe("withdrawn");
    expect(handOffReminder(sql, claimed.id, "run", at)).toBe(false);
  });
});

describe("cancel and done", () => {
  it("cancel stops every nudge and the deadline stays cancelled when the letter is read again", async () => {
    const sql = openDb();
    const created = await track(sql);
    if (!("deadline" in created)) throw new Error("no deadline");
    const out = cancelDeadline(sql, created.deadline.id, NOW);
    expect(out).toMatchObject({ status: "cancelled", nudgesInFlight: 0 });
    expect(listReminders(sql).every((r) => r.status === "cancelled")).toBe(true);
    const reread = await track(sql, letter({ dueDate: "2026-12-22" }));
    expect(reread).toMatchObject({ status: "closed" });
    expect(listReminders(sql).filter((r) => r.status === "scheduled")).toHaveLength(0);
    expect(cancelDeadline(sql, "dl-unknown", NOW)).toBeNull();
  });

  it("done stops the nudges and keeps the deadline as done", async () => {
    const sql = openDb();
    const created = await track(sql);
    if (!("deadline" in created)) throw new Error("no deadline");
    const out = updateDeadline(sql, created.deadline.id, { status: "done" }, PACIFIC, NOW, TEN);
    expect(out).toMatchObject({ status: "done", deadline: { status: "done" } });
    expect(listReminders(sql).every((r) => r.status === "cancelled")).toBe(true);
    // Nudges that never went out are not listed; nothing is left to send.
    expect(listDeadlines(sql)[0].nudges).toEqual([]);
  });

  it("a person's new date replaces the nudges like a moved letter", async () => {
    const sql = openDb();
    const created = await track(sql);
    if (!("deadline" in created)) throw new Error("no deadline");
    const out = updateDeadline(sql, created.deadline.id, { dueDate: "2026-12-29" }, PACIFIC, NOW, TEN);
    expect(out).toMatchObject({ status: "moved", moved: { from: "2026-12-15", to: "2026-12-29" } });
    expect(listReminders(sql).filter((r) => r.status === "scheduled")).toHaveLength(4);
  });
});

describe("quiet hours at delivery", () => {
  async function dueNudge(nowMs: number) {
    const sql = openDb();
    await track(sql);
    const first = listReminders(sql)[0];
    sql.exec("UPDATE reminders SET next_at_ms = ? WHERE id = ?", nowMs - 1, first.id);
    const [claimed] = claimDueReminders(sql, nowMs, 120_000, "run", 25);
    return { sql, id: claimed.id };
  }

  it("inside 9:00 to 20:00 on its day, a nudge goes", async () => {
    const at = Date.parse("2026-12-01T18:00:00.000Z");
    const { sql, id } = await dueNudge(at);
    expect(gateNudge(sql, id, "run", at)).toBeNull();
    expect(handOffReminder(sql, id, "run", at)).toBe(true);
  });

  it("before 9:00 it waits for 9:00, and is never handed off early", async () => {
    // 07:00 Pacific on December 1.
    const at = Date.parse("2026-12-01T15:00:00.000Z");
    const { sql, id } = await dueNudge(at);
    expect(gateNudge(sql, id, "run", at)).toBe("deferred");
    const r = getReminder(sql, id)!;
    expect(r.status).toBe("scheduled");
    expect(claimDueReminders(sql, at, 120_000, "run2", 25)).toEqual([]);
    expect(claimDueReminders(sql, Date.parse("2026-12-01T17:00:00.000Z"), 120_000, "run3", 25).map((x) => x.id)).toEqual([id]);
  });

  it("after 20:00 its day has passed: it is dropped, not sent late with a wrong count", async () => {
    // 21:00 Pacific on December 1.
    const at = Date.parse("2026-12-02T05:00:00.000Z");
    const { sql, id } = await dueNudge(at);
    expect(gateNudge(sql, id, "run", at)).toBe("missed");
    expect(getReminder(sql, id)?.status).toBe("dropped");
    expect(handOffReminder(sql, id, "run", at)).toBe(false);
  });

  it("an ordinary reminder is never held", async () => {
    const sql = openDb();
    expect(gateNudge(sql, "rem-abc", "run", Date.parse("2026-12-02T05:00:00.000Z"))).toBeNull();
  });
});

describe("conversation delete", () => {
  it("removes deadlines with the conversation, and their nudges never send", async () => {
    const sql = openDb();
    await track(sql);
    removeConversationState(sql, NOW, 1);
    expect(removeDeadlines(sql)).toBe(1);
    expect(listDeadlines(sql)).toEqual([]);
    expect(listReminders(sql).every((r) => r.status === "cancelled")).toBe(true);
  });

  it("the same letter after a delete is tracked again with a full set of nudges", async () => {
    const sql = openDb();
    await track(sql);
    removeConversationState(sql, NOW, 1);
    removeDeadlines(sql);
    const again = await track(sql, letter({ generation: 1 }));
    expect(again).toMatchObject({ status: "created" });
    if (!("deadline" in again)) throw new Error("no deadline");
    expect(again.deadline.nudges.map((n) => n.status)).toEqual(["scheduled", "scheduled", "scheduled", "scheduled"]);
  });

  it("a nudge identity already taken is an error, never a deadline with no nudges", async () => {
    const sql = openDb();
    const input = letter();
    const id = await deadlineIdFor(input.idempotencyKey);
    sql.exec(
      "INSERT INTO reminders(id, text, due_at_ms, generation, status, next_at_ms, created_at_ms) VALUES (?, 'x', 0, 0, 'cancelled', 0, 0)",
      `nudge:${id}:g0:0:14`,
    );
    await expect(track(sql, input)).rejects.toThrow(/nudge/i);
  });

  it("a deadline sent under an older generation is refused", async () => {
    const sql = openDb();
    removeConversationState(sql, NOW, 2);
    const out = await track(sql, letter({ generation: 1 }));
    expect(out).toEqual({ stale: true });
    expect(listDeadlines(sql)).toEqual([]);
    const current = await track(sql, letter({ generation: 2 }));
    expect(current).toMatchObject({ status: "created" });
    expect(listReminders(sql).map((r) => r.generation)).toEqual([2, 2, 2, 2]);
  });
});
