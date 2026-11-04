import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { personIdFor } from "../agent/lib/engine.js";
import { renderDeadlines } from "../agent/lib/deadlines.js";
import { resolveDueDate } from "../agent/lib/due-date.js";
import { PROFILE_CLOSE, PROFILE_OPEN } from "../agent/lib/profile.js";
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

describe("due dates in words", () => {
  const dueDate = (words: string, said = words) => {
    const due = resolveDueDate(words, TURN_AT, "America/Los_Angeles", { person: [said], asked: null });
    return due?.status === "live" ? due.date : null;
  };

  it("reads the forms people and letters use, and the next such date when no year is given", () => {
    expect(dueDate("November 12")).toBe("2026-11-12");
    expect(dueDate("Nov 12th, 2027")).toBe("2027-11-12");
    expect(dueDate("11/12")).toBe("2026-11-12");
    expect(dueDate("1/5")).toBe("2027-01-05");
    expect(dueDate("2026-12-01")).toBe("2026-12-01");
    expect(dueDate("February 30")).toBeNull();
    expect(dueDate("soon")).toBeNull();
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

  it("whose task it is counts: my renewal and her renewal stay two", async () => {
    await trackDeadline.execute({ title: "My Medicaid renewal", due: "November 12", program: "Medicaid", kind: "renewal" }, ctx("turn_dl_0021"));
    await trackDeadline.execute({ title: "Her Medicaid renewal", due: "November 12", program: "Medicaid", kind: "renewal" }, ctx("turn_dl_0021"));
    expect(engine.deadlinesOf(PERSON)).toHaveLength(2);
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

describe("a due date's year", () => {
  type Answer = { dueDate: string; status: string; firstNudgeAt: string | null; today?: string; tell?: string; note?: string };
  // Engine's clock and the turn are one moment; the grant lasts minutes.
  async function at(iso: string): Promise<number> {
    const ms = Date.parse(iso);
    vi.setSystemTime(ms);
    engine.now = () => ms;
    grant = await grantFor(HANDLE);
    return ms;
  }
  const said = (turnId: string, words: string, turnAtMs: number) =>
    toolCtx({ handleHash: HANDLE, turnId, grant, generation: 0, turnAtMs, messages: [{ role: "user", content: words }] });
  const track = async (due: string, words: string, turnAtMs: number, extra: { kind?: "renewal" | "interview" } = {}) =>
    (await trackDeadline.execute({ title: "Food benefits renewal", due, ...extra }, said("turn_year_0001", words, turnAtMs))) as Answer;
  const livingIn = (state: string) => ({ person: { address: { state: { value: state, source: "person", updatedAt: "2026-10-30T00:00:00.000Z" } } } }) as never;
  const scheduled = () => engine.deadlinesOf(PERSON).flatMap((d) => d.nudges.filter((n) => n.status === "scheduled").map((n) => n.daysBefore));

  // Production trace wrun_41M6J3HAAP0GXDAG4B4GWSNZ0R, synthetic person.
  const TRACED = "2026-11-04T01:45:19.191Z";
  const TRACED_WORDS = "the letter says my renewal form is due November 24. can you fill out my renewal for me";

  it("a year the model made up never reaches Engine: the date goes live with its reminders", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2024-11-24", TRACED_WORDS, turnAtMs, { kind: "renewal" });
    expect(out).toMatchObject({ dueDate: "2026-11-24", status: "created", firstNudgeAt: "2026-11-10T18:00:00.000Z" });
    expect(engine.deadlinesOf(PERSON).map((d) => d.dueDate)).toEqual(["2026-11-24"]);
    expect(scheduled()).toEqual([14, 7, 2, 0]);
    expect(engine.remindersOf(PERSON).filter((r) => r.status === "scheduled")).toHaveLength(4);
    expect(out.note).toContain("2026");
  });

  it("an interview gets its own days, the day before in place of two days out", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2023-12-01", "my interview is December 1", turnAtMs, { kind: "interview" });
    expect(out).toMatchObject({ dueDate: "2026-12-01", firstNudgeAt: "2026-11-17T18:00:00.000Z" });
    expect(scheduled()).toEqual([14, 7, 1, 0]);
  });

  it("the person's words with no year take the same path", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("November 24", TRACED_WORDS, turnAtMs);
    expect(out).toMatchObject({ dueDate: "2026-11-24", firstNudgeAt: "2026-11-10T18:00:00.000Z" });
    expect(out.note).toBeUndefined();
  });

  it("a later year the person did not say is not kept either, and one they said is", async () => {
    const turnAtMs = await at(TRACED);
    expect(await track("2027-11-24", TRACED_WORDS, turnAtMs)).toMatchObject({ dueDate: "2026-11-24" });
    expect(await track("11/24/2027", "my renewal is due 11/24/27", turnAtMs)).toMatchObject({ dueDate: "2027-11-24" });
    expect(await track("March 3, 2027", "it is due March 3 2027", turnAtMs)).toMatchObject({ dueDate: "2027-03-03" });
  });

  it("a date just gone by, whatever year the model gives it, is not saved and the model is told", async () => {
    const turnAtMs = await at(TRACED);
    for (const due of ["2026-10-27", "2024-10-27", "October 27"]) {
      const out = await track(due, "it was due last week", turnAtMs);
      expect(out).toMatchObject({ status: "passed", dueDate: "2026-10-27", today: "2026-11-03" });
      expect(out.tell).toMatch(/has already passed/);
    }
    expect(engine.deadlinesOf(PERSON)).toEqual([]);
    expect(engine.remindersOf(PERSON)).toEqual([]);
  });

  it("a year the person said stands even when it has passed, and is not moved ahead", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2024-11-24", "my renewal was due November 24, 2024", turnAtMs);
    expect(out).toMatchObject({ status: "passed", dueDate: "2024-11-24" });
    expect(engine.deadlinesOf(PERSON)).toEqual([]);
  });

  it("a letter's year in the person's turn counts, the profile's does not, and neither do Mano's replies", async () => {
    const turnAtMs = await at(TRACED);
    const input = { title: "Food benefits renewal", due: "2024-11-24" };
    const fromLetter = toolCtx({
      handleHash: HANDLE, turnId: "turn_year_letter", grant, generation: 0, turnAtMs,
      messages: [{ role: "user", content: [{ type: "text", text: "what about this\n\nThe letter says: due November 24, 2024." }] }],
    });
    expect(await trackDeadline.execute(input, fromLetter)).toMatchObject({ status: "passed", dueDate: "2024-11-24" });
    const notThePerson = toolCtx({
      handleHash: HANDLE, turnId: "turn_year_other", grant, generation: 0, turnAtMs,
      messages: [
        { role: "user", content: `Mano's records\n${PROFILE_OPEN}{"since":"2024-01-02"}${PROFILE_CLOSE}` },
        { role: "assistant", content: "Your renewal from 2024 is closed." },
        { role: "user", content: "it is due November 24" },
      ],
    });
    expect(await trackDeadline.execute(input, notThePerson)).toMatchObject({ dueDate: "2026-11-24", status: "created" });
  });

  it("December 30, \"January 3\" is four days away, in the next year", async () => {
    const turnAtMs = await at("2026-12-30T20:00:00.000Z");
    for (const due of ["2026-01-03", "2025-01-03", "January 3", "1/3"]) {
      expect(await track(due, "it is due January 3", turnAtMs)).toMatchObject({ dueDate: "2027-01-03", firstNudgeAt: "2027-01-01T18:00:00.000Z" });
    }
    expect(scheduled()).toEqual([2, 0]);
  });

  it("a leap day: the next one when it is near, a question when it is not", async () => {
    let turnAtMs = await at("2027-12-20T20:00:00.000Z");
    expect(await track("2024-02-29", "it is due February 29", turnAtMs)).toMatchObject({ dueDate: "2028-02-29", firstNudgeAt: "2028-02-15T18:00:00.000Z" });
    expect(scheduled()).toEqual([14, 7, 2, 0]);
    turnAtMs = await at("2028-03-10T20:00:00.000Z");
    expect(await track("February 29", "it is due February 29", turnAtMs)).toMatchObject({ status: "passed", dueDate: "2028-02-29" });
    turnAtMs = await at(TRACED);
    await expect(track("February 29", "it is due February 29", turnAtMs)).rejects.toThrow(/Could not read/);
    await expect(track("February 29, 2027", "it is due February 29, 2027", turnAtMs)).rejects.toThrow(/Could not read/);
  });

  it("today is the person's today, by the state on their profile, not UTC's", async () => {
    // 23:30 on November 3 in California; already November 4 in UTC and Denver.
    let turnAtMs = await at("2026-11-04T07:30:00.000Z");
    const today = await track("November 3", "it is due November 3", turnAtMs);
    expect(today).toMatchObject({ dueDate: "2026-11-03", status: "created", firstNudgeAt: null });
    expect(today.note).toMatch(/no reminder/);
    expect(await track("November 4", "it is due November 4", turnAtMs)).toMatchObject({ dueDate: "2026-11-04", firstNudgeAt: "2026-11-04T18:00:00.000Z" });

    // The same moment is already past the date in New York.
    engine.profile = livingIn("NY");
    expect(await track("November 3", "it was due November 3", turnAtMs)).toMatchObject({ status: "passed", dueDate: "2026-11-03", today: "2026-11-04" });

    // Guam is ahead of UTC: 01:00 on November 4 there, 15:00 on November 3 in UTC.
    turnAtMs = await at("2026-11-03T15:00:00.000Z");
    engine.profile = livingIn("GU");
    expect(await track("November 3", "it was due November 3", turnAtMs)).toMatchObject({ status: "passed", today: "2026-11-04" });
  });

  it("a number elsewhere in the message is not the date's year", async () => {
    const turnAtMs = await at(TRACED);
    for (const words of [
      "My case number is 2024. Renewal due November 24",
      "My birth date is 2000-01-24. My renewal is due November 24.",
      "Next year I move. It is due November 24.",
      "It is due November 24. In 2024 I missed one.",
      "Tengo 2024 dólares de renta. Vence el 24 de noviembre.",
      "It is due November 24 last I heard",
      "My interview is November 24 next week, I think",
    ]) {
      expect(await track("2024-11-24", words, turnAtMs), words).toMatchObject({ dueDate: "2026-11-24", firstNudgeAt: "2026-11-10T18:00:00.000Z" });
    }
    expect(await track("2027-11-24", "Next year I move. It is due November 24.", turnAtMs)).toMatchObject({ dueDate: "2026-11-24" });
  });

  it("the same day in another year does not take over a date the person gave with no year", async () => {
    const turnAtMs = await at(TRACED);
    for (const words of ["My birth date is 2000-11-24. My renewal is due November 24.", "I was born November 24, 2000. My renewal is due November 24."]) {
      expect(await track("2000-11-24", words, turnAtMs), words).toMatchObject({ dueDate: "2026-11-24", status: expect.not.stringMatching("passed") });
    }
  });

  it("a year written any way the person writes one stays, even when the model leaves it out", async () => {
    const turnAtMs = await at(TRACED);
    for (const words of [
      "due November 24 '27",
      "due November 24, ’27",
      "due November 24 twenty twenty-seven",
      "due November 24, two thousand twenty seven",
      "due November 24, two thousand and twenty-seven",
      "due the 24th of November, 2027",
      "due 24 November 2027",
      "due 2027-11-24",
      "due 11-24-2027",
      "due 11.24.27",
      "vence el 24 de noviembre de 2027",
      "vence el 24 de noviembre del 2027",
      "vence el 24 de noviembre del 27",
      "vence el 24/11/2027",
      "vence el 24 de noviembre de dos mil veintisiete",
    ]) {
      for (const due of ["2027-11-24", "2024-11-24", "November 24"]) {
        expect(await track(due, words, turnAtMs), `${words} / ${due}`).toMatchObject({ dueDate: "2027-11-24" });
      }
    }
  });

  it("the note names no missing year when the person gave one", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("2024-11-24", "due November 24 '27", turnAtMs);
    expect(out.note ?? "").not.toMatch(/no year/);
  });

  it("relative years count next to the date, in English and Spanish", async () => {
    const turnAtMs = await at(TRACED);
    for (const words of [
      "Mi renovación vence el 30 de septiembre del próximo año",
      "vence el 30 de septiembre del ano que viene",
      "vence el 30 de septiembre del año siguiente",
      "vence el 30 de septiembre el año entrante",
      "el próximo año, el 30 de septiembre",
      "el año que viene el 30 de septiembre",
      "vence el próximo 30 de septiembre",
      "it is due September 30 next year",
      "it is due September 30 of next year",
      "next year on September 30",
      "due next September 30",
    ]) {
      expect(await track("2027-09-30", words, turnAtMs), words).toMatchObject({ dueDate: "2027-09-30", status: expect.not.stringMatching("passed") });
    }
    for (const words of ["vence el 24 de noviembre de este año", "due November 24 this year"]) {
      expect(await track("2027-11-24", words, turnAtMs), words).toMatchObject({ dueDate: "2026-11-24" });
    }
    for (const words of ["venció el 30 de septiembre del año pasado", "venció el 30 de septiembre del año anterior", "it was due September 30 last year"]) {
      expect(await track("2025-09-30", words, turnAtMs), words).toMatchObject({ status: "passed", dueDate: "2025-09-30" });
    }
    expect(await track("2026-09-30", "venció el pasado 30 de septiembre", turnAtMs)).toMatchObject({ status: "passed", dueDate: "2026-09-30" });
  });

  it("reads the date itself in Spanish, as the person writes it", async () => {
    const turnAtMs = await at(TRACED);
    expect(await track("24 de noviembre", "vence el 24 de noviembre", turnAtMs)).toMatchObject({ dueDate: "2026-11-24" });
    expect(await track("1 de diciembre", "vence el primero de diciembre", turnAtMs)).toMatchObject({ dueDate: "2026-12-01" });
    expect(await track("30 de septiembre de 2027", "vence el 30 de septiembre de 2027", turnAtMs)).toMatchObject({ dueDate: "2027-09-30" });
    expect(await track("sept 30", "vence el 30 de setiembre del próximo año", turnAtMs)).toMatchObject({ dueDate: "2027-09-30" });
  });

  it("asking gets an answer: a year alone, or a yes to the date Mano spelled out, makes it live", async () => {
    const turnAtMs = await at(TRACED);
    const first = { role: "user", content: "my renewal is September 30" };
    expect(await track("2027-09-30", first.content, turnAtMs)).toMatchObject({ status: "passed" });
    const asked = { role: "assistant", content: "September 30, 2026 has passed. Do you mean September 30, 2027?" };
    const answering = async (answer: string) =>
      (await trackDeadline.execute(
        { title: "Food benefits renewal", due: "2027-09-30" },
        toolCtx({ handleHash: HANDLE, turnId: "turn_year_0002", grant, generation: 0, turnAtMs, messages: [first, asked, { role: "user", content: answer }] }),
      )) as Answer;
    for (const answer of ["2027", "'27.", "next year", "Yes, next year", "del próximo año", "sí, el año que viene", "yes", "Sí", "correct", "September 30, 2027"]) {
      expect(await answering(answer), answer).toMatchObject({ dueDate: "2027-09-30", status: expect.not.stringMatching("passed") });
    }
    for (const answer of ["no", "hmm", "my case number is 2027", "tomorrow"]) {
      expect(await answering(answer), answer).toMatchObject({ status: "passed" });
    }
  });

  it("two years for one date in one message makes Mano ask, and saves nothing", async () => {
    const turnAtMs = await at(TRACED);
    const out = await track("March 5", "It was March 5, 2027 or March 5, 2028, I am not sure", turnAtMs);
    expect(out).toMatchObject({ status: "ask" });
    expect(out.tell).toMatch(/which/i);
    expect(engine.deadlinesOf(PERSON)).toEqual([]);
    expect(await track("2028-03-05", "It was March 5, 2027 or March 5, 2028, I am not sure", turnAtMs)).toMatchObject({ dueDate: "2028-03-05" });
  });

  it("a newer message speaks for the date over an older one", async () => {
    const turnAtMs = await at(TRACED);
    const history = (...contents: string[]) => toolCtx({
      handleHash: HANDLE, turnId: "turn_year_0003", grant, generation: 0, turnAtMs,
      messages: contents.map((content) => ({ role: "user", content })),
    });
    const input = { title: "Food benefits renewal", due: "November 24" };
    expect(await trackDeadline.execute(input, history("it was due November 24, 2025", "now it is due November 24"))).toMatchObject({ dueDate: "2026-11-24" });
    expect(await trackDeadline.execute(input, history("it is due November 24, 2027", "please track November 24"))).toMatchObject({ dueDate: "2027-11-24" });
    const moved = { title: "Food benefits renewal", due: "March 5" };
    expect(await trackDeadline.execute(moved, history("it is due March 5, 2027", "sorry, March 5, 2028"))).toMatchObject({ dueDate: "2028-03-05" });
  });

  it("moving a deadline reads its date the same way, and a past date moves nothing", async () => {
    const turnAtMs = await at(TRACED);
    const { deadlineId } = (await track("2024-11-24", TRACED_WORDS, turnAtMs)) as unknown as Tracked;
    const moved = await updateDeadline.execute({ deadlineId, due: "2024-12-01" }, said("turn_year_move1", "it moved to December 1", turnAtMs));
    expect(moved).toMatchObject({ found: true, status: "moved", moved: { from: "2026-11-24", to: "2026-12-01" }, dueDate: "2026-12-01" });
    const past = await updateDeadline.execute({ deadlineId, due: "2026-10-27" }, said("turn_year_move2", "no it was October 27", turnAtMs));
    expect(past).toMatchObject({ status: "passed", dueDate: "2026-10-27" });
    expect(engine.deadlinesOf(PERSON).map((d) => d.dueDate)).toEqual(["2026-12-01"]);
    expect(scheduled().length).toBeGreaterThan(0);
  });
});

describe("the turn's deadline context", () => {
  it("shows open deadlines with the last nudge Mano texted, titles quoted as data", async () => {
    await trackDeadline.execute({ title: "CalFresh renewal", due: "November 12", program: "CalFresh", kind: "renewal" }, ctx("turn_dl_0012"));
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
