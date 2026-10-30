import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { personIdFor } from "../agent/lib/engine.js";
import { parseDueDate, renderDeadlines } from "../agent/lib/deadlines.js";
import cancelDeadline from "../agent/tools/cancel_deadline.js";
import listDeadlines from "../agent/tools/list_deadlines.js";
import trackDeadline from "../agent/tools/track_deadline.js";
import updateDeadline from "../agent/tools/update_deadline.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "d".repeat(64);
const PERSON = personIdFor(HANDLE);
// Friday, October 30, 2026, 14:00 in Denver.
const TURN_AT = Date.parse("2026-10-30T20:00:00.000Z");
let engine: EngineDouble;
let grant: string;

// Tool results, which Eve types as a value or a stream.
type Tracked = { deadlineId: string };
type Listed = { deadlines: { title: string; dueDate: string; daysLeft: number }[] };

function ctx(turnId: string) {
  return toolCtx({ handleHash: HANDLE, turnId, grant, generation: 0, turnAtMs: TURN_AT });
}

beforeEach(async () => {
  engine = new EngineDouble();
  engine.now = () => TURN_AT;
  grant = await grantFor(HANDLE);
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("due dates in words", () => {
  it("reads the forms people and letters use, and the next such date when no year is given", () => {
    expect(parseDueDate("November 12", TURN_AT)).toBe("2026-11-12");
    expect(parseDueDate("Nov 12th, 2027", TURN_AT)).toBe("2027-11-12");
    expect(parseDueDate("11/12", TURN_AT)).toBe("2026-11-12");
    expect(parseDueDate("1/5", TURN_AT)).toBe("2027-01-05");
    expect(parseDueDate("2026-12-01", TURN_AT)).toBe("2026-12-01");
    expect(parseDueDate("February 30", TURN_AT)).toBeNull();
    expect(parseDueDate("soon", TURN_AT)).toBeNull();
  });
});

describe("deadline tools", () => {
  it("tracks a deadline the person names, once per turn even when retried", async () => {
    const input = { title: "CalFresh renewal", due: "November 12", program: "CalFresh" };
    const first = (await trackDeadline.execute(input, ctx("turn_dl_0001"))) as Tracked;
    expect(first).toMatchObject({ title: "CalFresh renewal", dueDate: "2026-11-12", status: "created" });
    const again = await trackDeadline.execute({ ...input, title: "the CalFresh renewal" }, ctx("turn_dl_0001"));
    expect(again).toMatchObject({ deadlineId: first.deadlineId, status: "updated" });
    // Engine keeps the newest wording; the nudge name comes from its closed set either way.
    expect(engine.deadlinesOf(PERSON)).toHaveLength(1);
  });

  it("two tasks due the same day in one turn stay two deadlines", async () => {
    await trackDeadline.execute({ title: "CalFresh renewal", due: "November 12" }, ctx("turn_dl_0020"));
    await trackDeadline.execute({ title: "Medi-Cal interview", due: "November 12" }, ctx("turn_dl_0020"));
    expect(engine.deadlinesOf(PERSON).map((d) => d.title).sort()).toEqual(["CalFresh renewal", "Medi-Cal interview"]);
  });

  it("lists what is coming up, moves a date, marks one done and cancels another", async () => {
    const renewal = (await trackDeadline.execute({ title: "CalFresh renewal", due: "November 12" }, ctx("turn_dl_0002"))) as Tracked;
    const other = (await trackDeadline.execute({ title: "Medi-Cal packet", due: "12/01" }, ctx("turn_dl_0003"))) as Tracked;
    const listed = (await listDeadlines.execute({}, ctx("turn_dl_0004"))) as Listed;
    expect(listed.deadlines.map((d) => [d.title, d.dueDate, d.daysLeft])).toEqual([
      ["CalFresh renewal", "2026-11-12", 13],
      ["Medi-Cal packet", "2026-12-01", 32],
    ]);

    const moved = await updateDeadline.execute({ deadlineId: renewal.deadlineId, due: "November 19" }, ctx("turn_dl_0005"));
    expect(moved).toMatchObject({ found: true, status: "moved", moved: { from: "2026-11-12", to: "2026-11-19" } });

    // "I already sent it, stop reminding me."
    const done = await updateDeadline.execute({ deadlineId: renewal.deadlineId, done: true }, ctx("turn_dl_0006"));
    expect(done).toMatchObject({ found: true, status: "done", nextNudgeAt: null, nudgeAlreadySending: false });

    expect(await cancelDeadline.execute({ deadlineId: other.deadlineId }, ctx("turn_dl_0007"))).toMatchObject({ found: true, status: "cancelled" });
    expect(((await listDeadlines.execute({}, ctx("turn_dl_0008"))) as Listed).deadlines).toEqual([]);
    // Nothing is left to send.
    expect(engine.remindersOf(PERSON).filter((r) => r.status === "scheduled")).toEqual([]);
    expect(await cancelDeadline.execute({ deadlineId: "dl-00000000000000000000000000000000" }, ctx("turn_dl_0009"))).toEqual({ found: false });
  });

  it("says deadlines are not available when Engine has no deadline routes, never inventing one", async () => {
    const without: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname.endsWith("/deadlines") ? new Response("Not found", { status: 404 }) : engine.fetch(input, init);
    vi.stubGlobal("fetch", without);
    await expect(listDeadlines.execute({}, ctx("turn_dl_0010"))).rejects.toThrow(/not available/);
    await expect(trackDeadline.execute({ title: "CalFresh renewal", due: "November 12" }, ctx("turn_dl_0011"))).rejects.toThrow(/not available/);
  });
});

describe("the turn's deadline context", () => {
  it("shows open deadlines with the last nudge Mano texted, titles quoted as data", async () => {
    await trackDeadline.execute({ title: "CalFresh renewal", due: "November 12" }, ctx("turn_dl_0012"));
    // The alarm sends the first nudge.
    engine.now = () => Date.parse("2026-10-31T17:00:00.000Z");
    expect(engine.deliverDue(PERSON).map((s) => s.text)).toEqual(["Your CalFresh renewal is due in 12 days, on November 12. Want me to start it?"]);
    const deadlines = (await engine.person(PERSON).deadlines.list());
    const rendered = renderDeadlines(deadlines, Date.parse("2026-10-31T18:00:00.000Z"));
    expect(rendered).toContain('"CalFresh renewal", due 2026-11-12, in 12 days.');
    expect(rendered).toContain('Mano texted on 2026-10-31: "Your CalFresh renewal is due in 12 days, on November 12. Want me to start it?"');
    expect(renderDeadlines([], TURN_AT)).toBeNull();
  });
});
