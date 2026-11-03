import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import type { PersonAgent } from "../src/agents/person-agent.js";
import { timeZoneForState } from "../src/deadlines.js";

// Nudges are timed in the person's own zone, through the real worker,
// PersonAgent and profile store: the state on the profile when the
// deadline is tracked picks the zone, and MANO_NUDGE_TIME (09:30 in
// vitest.config.ts) is a local wall time there, on the right local day,
// on both sides of the next daylight saving change. The alarm's own
// delivery run at each scheduled instant hands that nudge to Channels
// then, so its quiet-hours window is in the same zone. With no state on
// file the zone is Pacific: 09:30 there is 06:30 to 13:30 local across
// the 50 states and DC, never between 22:00 and 06:00.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const NUDGE_TIME = "09:30";

const STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(handleHash: string, method: string, path: string, body?: unknown) {
  const grant = await mintHandleGrant(handleHash, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(handleHash)}${path}`, {
    method,
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Nudge = { reminderId: string; daysBefore: number; at: string };

// A person whose profile says they live in this state (none: no state on
// file), with one interview deadline: its nudges as GET lists them.
async function nudgesFor(tag: string, state: string | null, dueDate: string): Promise<Nudge[]> {
  return (await personWith(tag, state, dueDate)).nudges;
}

async function personWith(tag: string, state: string | null, dueDate: string): Promise<{ h: string; nudges: Nudge[] }> {
  vi.stubGlobal("fetch", async () => Response.json({ sent: true }));
  const h = handle(tag);
  if (state) {
    const patched = await call(h, "PATCH", "/profile", {
      idempotencyKey: `${tag}-state`,
      source: "person",
      generation: 0,
      fields: { "person.address.state": state },
    });
    expect(patched.status).toBe(200);
  }
  const created = await call(h, "POST", "/deadlines", {
    title: "Medi-Cal interview",
    dueDate,
    program: "Medi-Cal",
    kind: "interview",
    source: { kind: "letter", documentId: "doc-1", sentence: "Your phone interview is on the date above." },
    idempotencyKey: "letter:doc-1:interview",
    generation: 0,
  });
  expect(created.status).toBe(201);
  const list = (await (await call(h, "GET", "/deadlines")).json()) as { deadlines: { nudges: Nudge[] }[] };
  return { h, nudges: list.deadlines[0].nudges };
}

// The clock set to each nudge's scheduled instant in turn, and the
// delivery run the alarm makes (claim, quiet-hours gate, handoff to
// Channels). Answers the keys Channels was handed at each instant.
async function deliveredAtEachInstant(h: string, nudges: Nudge[]): Promise<string[][]> {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(personIdForHandle(h)));
  const handed: string[][] = [];
  for (const n of nudges) {
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((JSON.parse(String(init?.body)) as { key: string }).key);
      return Response.json({ sent: true });
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(n.at));
    await runInDurableObject(stub, (instance) => (instance as PersonAgent).deliverDueReminders());
    vi.useRealTimers();
    handed.push(keys);
  }
  return handed;
}

// The wall clock in a zone, read independently of Engine's own zone math.
function local(at: string | number, timeZone: string): { date: string; time: string; offsetMin: number } {
  const ms = typeof at === "number" ? at : Date.parse(at);
  const p: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const part of format.formatToParts(new Date(ms))) p[part.type] = part.value;
  const wallMs = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, offsetMin: Math.round((wallMs - ms) / 60_000) };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The first US daylight saving change at least 11 days from now, as the
// local day it happens on. A deadline 5 days after it has its 14- and
// 7-day nudges before the change and its 2-day and day-of nudges after.
function nextChangeDay(): string {
  const zone = "America/Los_Angeles";
  let day = addDays(new Date().toISOString().slice(0, 10), 11);
  for (let i = 0; i < 400; i++) {
    const next = addDays(day, 1);
    if (local(`${day}T20:00:00Z`, zone).offsetMin !== local(`${next}T20:00:00Z`, zone).offsetMin) return next;
    day = next;
  }
  throw new Error("no daylight saving change within 400 days");
}

describe("nudges are timed in the person's own zone", () => {
  const change = nextChangeDay();
  const due = addDays(change, 5);

  for (const [state, zone] of [
    ["CA", "America/Los_Angeles"],
    ["NY", "America/New_York"],
  ] as const) {
    it(`a person in ${state} gets each nudge at ${NUDGE_TIME} ${zone} on its own day, across the daylight saving change`, async () => {
      const { h, nudges } = await personWith(`dz-${state}`, state, due);
      expect(nudges.map((n) => n.daysBefore)).toEqual([14, 7, 2, 0]);
      expect(await deliveredAtEachInstant(h, nudges)).toEqual(nudges.map((n) => [`reminder:${n.reminderId}`]));
      for (const n of nudges) expect(local(n.at, zone)).toMatchObject({ date: addDays(due, -n.daysBefore), time: NUDGE_TIME });
      // The change falls between the 7- and 2-day nudges: same local
      // time, a different UTC offset.
      const offsets = nudges.map((n) => local(n.at, zone).offsetMin);
      expect(offsets[0]).toBe(offsets[1]);
      expect(offsets[2]).toBe(offsets[3]);
      expect(offsets[1]).not.toBe(offsets[2]);
    });
  }

  it("a person in Hawaii, which keeps one offset all year, gets theirs at the same local time", async () => {
    const { h, nudges } = await personWith("dz-HI", "HI", due);
    expect(nudges.map((n) => n.daysBefore)).toEqual([14, 7, 2, 0]);
    expect(await deliveredAtEachInstant(h, nudges)).toEqual(nudges.map((n) => [`reminder:${n.reminderId}`]));
    for (const n of nudges) expect(local(n.at, "Pacific/Honolulu")).toEqual({ date: addDays(due, -n.daysBefore), time: NUDGE_TIME, offsetMin: -600 });
  });

  it("the same deadline lands at different instants for people in different zones", async () => {
    const [ca, ny] = [await nudgesFor("dz-same-CA", "CA", due), await nudgesFor("dz-same-NY", "NY", due)];
    expect(ca.map((n, i) => Date.parse(n.at) - Date.parse(ny[i].at))).toEqual([3, 3, 3, 3].map((h) => h * 3_600_000));
  });

  it("with no state on file, nudges are Pacific and never fall in anyone's night in the 50 states and DC", async () => {
    const { h, nudges } = await personWith("dz-none", null, due);
    expect(nudges.map((n) => n.daysBefore)).toEqual([14, 7, 2, 0]);
    expect(await deliveredAtEachInstant(h, nudges)).toEqual(nudges.map((n) => [`reminder:${n.reminderId}`]));
    for (const n of nudges) expect(local(n.at, "America/Los_Angeles")).toMatchObject({ date: addDays(due, -n.daysBefore), time: NUDGE_TIME });
    const zones = new Set(STATES.map((state) => timeZoneForState(state)));
    for (const zone of zones) {
      for (const n of nudges) {
        const hour = Number(local(n.at, zone).time.slice(0, 2));
        expect(hour, `${n.at} in ${zone}`).toBeGreaterThanOrEqual(6);
        expect(hour, `${n.at} in ${zone}`).toBeLessThan(22);
      }
    }
  });
});
