import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { personIdFor } from "../agent/lib/engine.js";
import { renderDeadlines } from "../agent/lib/deadlines.js";
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
  // list_deadlines counts days left from the wall clock, not the turn.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TURN_AT);
  engine = new EngineDouble();
  engine.now = () => TURN_AT;
  grant = await grantFor(HANDLE);
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("deadline tools", () => {
  it("tracks a deadline the person names, once per turn even when retried", async () => {
    const input = { title: "CalFresh renewal", due: "2026-11-12", program: "CalFresh" };
    const first = (await trackDeadline.execute(input, ctx("turn_dl_0001"))) as Tracked;
    expect(first).toMatchObject({ title: "CalFresh renewal", dueDate: "2026-11-12", status: "created" });
    const again = await trackDeadline.execute({ ...input, title: "the CalFresh renewal" }, ctx("turn_dl_0001"));
    expect(again).toMatchObject({ deadlineId: first.deadlineId, status: "updated" });
    // Engine keeps the newest wording; the nudge name comes from its closed set either way.
    expect(engine.deadlinesOf(PERSON)).toHaveLength(1);
  });

  it("two tasks due the same day in one turn stay two deadlines", async () => {
    await trackDeadline.execute({ title: "CalFresh renewal", due: "2026-11-12" }, ctx("turn_dl_0020"));
    await trackDeadline.execute({ title: "Medi-Cal interview", due: "2026-11-12" }, ctx("turn_dl_0020"));
    expect(engine.deadlinesOf(PERSON).map((d) => d.title).sort()).toEqual(["CalFresh renewal", "Medi-Cal interview"]);
  });

  it("whose task it is counts: my renewal and her renewal stay two", async () => {
    await trackDeadline.execute({ title: "My Medicaid renewal", due: "2026-11-12", program: "Medicaid", kind: "renewal" }, ctx("turn_dl_0021"));
    await trackDeadline.execute({ title: "Her Medicaid renewal", due: "2026-11-12", program: "Medicaid", kind: "renewal" }, ctx("turn_dl_0021"));
    expect(engine.deadlinesOf(PERSON)).toHaveLength(2);
  });

  it("lists what is coming up, moves a date, marks one done and cancels another", async () => {
    const renewal = (await trackDeadline.execute({ title: "CalFresh renewal", due: "2026-11-12" }, ctx("turn_dl_0002"))) as Tracked;
    const other = (await trackDeadline.execute({ title: "Medi-Cal packet", due: "2026-12-01" }, ctx("turn_dl_0003"))) as Tracked;
    const listed = (await listDeadlines.execute({}, ctx("turn_dl_0004"))) as Listed;
    expect(listed.deadlines.map((d) => [d.title, d.dueDate, d.daysLeft])).toEqual([
      ["CalFresh renewal", "2026-11-12", 13],
      ["Medi-Cal packet", "2026-12-01", 32],
    ]);

    const moved = await updateDeadline.execute({ deadlineId: renewal.deadlineId, due: "2026-11-19" }, ctx("turn_dl_0005"));
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
    await expect(trackDeadline.execute({ title: "CalFresh renewal", due: "2026-11-12" }, ctx("turn_dl_0011"))).rejects.toThrow(/not available/);
  });
});

describe("a due date's year", () => {
  type Answer = { dueDate: string; status: string; firstNudgeAt: string | null; today?: string; tell?: string; question?: string; note?: string };
  // Engine's clock and the turn are one moment; the grant lasts minutes.
  async function at(iso: string): Promise<number> {
    const ms = Date.parse(iso);
    vi.setSystemTime(ms);
    engine.now = () => ms;
    grant = await grantFor(HANDLE);
    return ms;
  }
  const turn = (turnAtMs: number) => toolCtx({ handleHash: HANDLE, turnId: "turn_year_0001", grant, generation: 0, turnAtMs });
  const track = async (due: string, turnAtMs: number, extra: { kind?: "renewal" | "interview"; yearConfirmed?: boolean } = {}) =>
    (await trackDeadline.execute({ title: "Food benefits renewal", due, ...extra }, turn(turnAtMs))) as Answer;
  const livingIn = (state: string) => ({ person: { address: { state: { value: state, source: "person", updatedAt: "2026-10-30T00:00:00.000Z" } } } }) as never;
  const scheduled = () => engine.deadlinesOf(PERSON).flatMap((d) => d.nudges.filter((n) => n.status === "scheduled").map((n) => n.daysBefore));
  const nothingSaved = () => {
    expect(engine.deadlinesOf(PERSON)).toEqual([]);
    expect(engine.remindersOf(PERSON)).toEqual([]);
  };

  // Production trace wrun_41M6J3HAAP0GXDAG4B4GWSNZ0R, synthetic person:
  // "the letter says my renewal form is due November 24", passed as 2024-11-24.
  const TRACED = "2026-11-04T01:45:19.191Z";

  it("a past year the model made up becomes the next such date, live with its reminders, and the model must say the year", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2024-11-24", turnAtMs, { kind: "renewal" });
    expect(out).toMatchObject({ dueDate: "2026-11-24", status: "created", firstNudgeAt: "2026-11-10T18:00:00.000Z" });
    expect(engine.deadlinesOf(PERSON).map((d) => d.dueDate)).toEqual(["2026-11-24"]);
    expect(scheduled()).toEqual([14, 7, 2, 0]);
    expect(engine.remindersOf(PERSON).filter((r) => r.status === "scheduled")).toHaveLength(4);
    expect(out.note).toContain("November 24, 2026");
    expect(out.note).toMatch(/with its year/);
  });

  it("an interview gets its own days, the day before in place of two days out", async () => {
    const turnAtMs = await at(TRACED);
    expect(await track("2023-12-01", turnAtMs, { kind: "interview" })).toMatchObject({ dueDate: "2026-12-01", firstNudgeAt: "2026-11-17T18:00:00.000Z" });
    expect(scheduled()).toEqual([14, 7, 1, 0]);
  });

  it("a date ahead within 183 days is saved with no note", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2026-11-24", turnAtMs);
    expect(out).toMatchObject({ dueDate: "2026-11-24", status: "created" });
    expect(out.note).toBeUndefined();
    const edge = await track("2027-05-05", turnAtMs);
    expect(edge).toMatchObject({ dueDate: "2027-05-05" });
    expect(edge.note).toBeUndefined();
  });

  it("a past date whose next occurrence is far off asks and saves nothing", async () => {
    const turnAtMs = await at(TRACED);
    for (const due of ["2026-10-27", "2024-10-27"]) {
      const out = await track(due, turnAtMs);
      expect(out).toMatchObject({ status: "ask", today: "2026-11-03" });
      expect(out.question).toContain("October 27, 2027");
    }
    nothingSaved();
  });

  it("a date far ahead while this year's is still to come asks with both dates and saves nothing", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2027-11-24", turnAtMs);
    expect(out).toMatchObject({ status: "ask" });
    expect(out.question).toContain("November 24, 2026");
    expect(out.question).toContain("November 24, 2027");
    nothingSaved();
  });

  it("a date far ahead asks when next year's is the nearer one still to come", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2028-01-05", turnAtMs);
    expect(out).toMatchObject({ status: "ask" });
    expect(out.question).toContain("January 5, 2027");
    expect(out.question).toContain("January 5, 2028");
    expect((await track("2028-09-30", turnAtMs)).question).toContain("September 30, 2027");
    nothingSaved();
    expect(await track("2028-01-05", turnAtMs, { yearConfirmed: true })).toMatchObject({ dueDate: "2028-01-05", status: "created" });
  });

  it("a far-off leap day with none nearer is saved, and the model must say the year", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2028-02-29", turnAtMs);
    expect(out).toMatchObject({ dueDate: "2028-02-29", status: "created" });
    expect(out.note).toMatch(/with its year/);
  });

  it("a date far ahead with no nearer one is saved, and the model must say the year", async () => {
    let turnAtMs = await at(TRACED);
    const nextYear = await track("2027-05-06", turnAtMs);
    expect(nextYear).toMatchObject({ dueDate: "2027-05-06", status: "created" });
    expect(nextYear.note).toMatch(/with its year/);
    turnAtMs = await at("2026-01-05T20:00:00.000Z");
    const thisYear = await track("2026-11-24", turnAtMs);
    expect(thisYear).toMatchObject({ dueDate: "2026-11-24", status: "created" });
    expect(thisYear.note).toMatch(/with its year/);
  });

  it("yearConfirmed saves the date as given, past or far ahead", async () => {
    const turnAtMs = await at(TRACED);
    const far = await track("2027-11-24", turnAtMs, { yearConfirmed: true });
    expect(far).toMatchObject({ dueDate: "2027-11-24", status: "created", firstNudgeAt: "2027-11-10T18:00:00.000Z" });
    expect(far.note).toBeUndefined();
    const past = await track("2026-10-27", turnAtMs, { yearConfirmed: true });
    expect(past).toMatchObject({ dueDate: "2026-10-27", status: "created", firstNudgeAt: null });
    expect(past.note).toMatch(/no reminder/);
    expect(engine.deadlinesOf(PERSON).map((d) => d.dueDate).sort()).toEqual(["2026-10-27", "2027-11-24"]);
  });

  it("only an ISO date is read: anything else asks and saves nothing, confirmed or not", async () => {
    const turnAtMs = await at(TRACED);
    for (const due of ["November 24", "4/3/2027", "11/24/27", "24 de noviembre", "2026-11-31", "2026-13-01", "soon"]) {
      for (const yearConfirmed of [false, true]) {
        expect(await track(due, turnAtMs, { yearConfirmed }), due).toMatchObject({ status: "ask", tell: expect.stringContaining("YYYY-MM-DD") });
      }
    }
    nothingSaved();
  });

  it("December 30, January 3 is four days away, in the next year, whichever year the model passes", async () => {
    const turnAtMs = await at("2026-12-30T20:00:00.000Z");
    const right = await track("2027-01-03", turnAtMs);
    expect(right).toMatchObject({ dueDate: "2027-01-03", firstNudgeAt: "2027-01-01T18:00:00.000Z" });
    expect(right.note).toBeUndefined();
    for (const due of ["2026-01-03", "2025-01-03"]) {
      const out = await track(due, turnAtMs);
      expect(out).toMatchObject({ dueDate: "2027-01-03", firstNudgeAt: "2027-01-01T18:00:00.000Z" });
      expect(out.note).toContain("January 3, 2027");
    }
    expect(scheduled()).toEqual([2, 0]);
  });

  it("a leap day: the next one when it is near, a question when it is not", async () => {
    let turnAtMs = await at("2027-12-20T20:00:00.000Z");
    expect(await track("2024-02-29", turnAtMs)).toMatchObject({ dueDate: "2028-02-29", firstNudgeAt: "2028-02-15T18:00:00.000Z" });
    expect(scheduled()).toEqual([14, 7, 2, 0]);
    turnAtMs = await at("2028-03-10T20:00:00.000Z");
    expect(await track("2028-02-29", turnAtMs)).toMatchObject({ status: "ask" });
    turnAtMs = await at(TRACED);
    expect(await track("2024-02-29", turnAtMs)).toMatchObject({ status: "ask" });
    expect(await track("2027-02-29", turnAtMs)).toMatchObject({ status: "ask" });
  });

  it("today is the person's today, by the state on their profile, not UTC's", async () => {
    // 23:30 on November 3 in California; already November 4 in UTC and Denver.
    let turnAtMs = await at("2026-11-04T07:30:00.000Z");
    const today = await track("2026-11-03", turnAtMs);
    expect(today).toMatchObject({ dueDate: "2026-11-03", status: "created", firstNudgeAt: null });
    expect(today.note).toMatch(/no reminder/);
    expect(await track("2026-11-04", turnAtMs)).toMatchObject({ dueDate: "2026-11-04", firstNudgeAt: "2026-11-04T18:00:00.000Z" });

    // The same moment is already past the date in New York.
    engine.profile = livingIn("NY");
    expect(await track("2026-11-03", turnAtMs)).toMatchObject({ status: "ask", today: "2026-11-04" });

    // Guam is ahead of UTC: 01:00 on November 4 there, 15:00 on November 3 in UTC.
    turnAtMs = await at("2026-11-03T15:00:00.000Z");
    engine.profile = livingIn("GU");
    expect(await track("2026-11-03", turnAtMs)).toMatchObject({ status: "ask", today: "2026-11-04" });
  });

  it("a leap day years off asks with the first real one, never an Engine error", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2032-02-29", turnAtMs);
    expect(out).toMatchObject({ status: "ask" });
    expect(out.question).toContain("February 29, 2028");
    expect(out.question).toContain("February 29, 2032");
    nothingSaved();
  });

  it("a date past Engine's two-year limit asks, confirmed or not, and the last day inside it saves", async () => {
    let turnAtMs = await at(TRACED);
    for (const due of ["2031-01-05", "2029-01-05", "2028-11-03"]) {
      expect(await track(due, turnAtMs, { yearConfirmed: true }), due).toMatchObject({ status: "ask", tell: expect.stringContaining("two years") });
    }
    expect(await track("2032-02-29", turnAtMs, { yearConfirmed: true })).toMatchObject({ status: "ask" });
    nothingSaved();
    expect(await track("2028-11-02", turnAtMs, { yearConfirmed: true })).toMatchObject({ dueDate: "2028-11-02", status: "created" });
    // Guam's today is a day ahead of UTC's, which Engine counts from.
    engine.profile = livingIn("GU");
    turnAtMs = await at("2026-11-03T15:00:00.000Z");
    expect(await track("2028-11-03", turnAtMs, { yearConfirmed: true })).toMatchObject({ dueDate: "2028-11-03", status: "created" });
  });

  it("moving a deadline to today, past its reminder time, says no reminder will go out", async () => {
    const turnAtMs = await at("2026-11-04T07:30:00.000Z");
    const { deadlineId } = (await track("2026-11-24", turnAtMs)) as unknown as Tracked;
    const moved = await updateDeadline.execute({ deadlineId, due: "2026-11-03" }, turn(turnAtMs));
    expect(moved).toMatchObject({ status: "moved", dueDate: "2026-11-03", nextNudgeAt: null });
    expect((moved as { note?: string }).note).toMatch(/no reminder/);
    const renamed = await updateDeadline.execute({ deadlineId, title: "Food benefits packet" }, turn(turnAtMs));
    expect((renamed as { note?: string }).note).toBeUndefined();
  });

  it("moving a deadline follows the same rule", async () => {
    const turnAtMs = await at(TRACED);
    const { deadlineId } = (await track("2024-11-24", turnAtMs)) as unknown as Tracked;
    const move = (due: string, yearConfirmed?: boolean) =>
      updateDeadline.execute({ deadlineId, due, ...(yearConfirmed ? { yearConfirmed } : {}) }, turn(turnAtMs));
    const moved = await move("2024-12-01");
    expect(moved).toMatchObject({ found: true, status: "moved", moved: { from: "2026-11-24", to: "2026-12-01" }, dueDate: "2026-12-01" });
    expect((moved as { note?: string }).note).toContain("December 1, 2026");
    for (const due of ["2026-10-27", "2027-12-01", "12/15"]) expect(await move(due), due).toMatchObject({ status: "ask" });
    expect(engine.deadlinesOf(PERSON).map((d) => d.dueDate)).toEqual(["2026-12-01"]);
    expect(scheduled().length).toBeGreaterThan(0);
    expect(await move("2027-12-01", true)).toMatchObject({ status: "moved", dueDate: "2027-12-01" });
  });
});

describe("the turn's deadline context", () => {
  it("shows open deadlines with the last nudge Mano texted, titles quoted as data", async () => {
    await trackDeadline.execute({ title: "CalFresh renewal", due: "2026-11-12", program: "CalFresh", kind: "renewal" }, ctx("turn_dl_0012"));
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
