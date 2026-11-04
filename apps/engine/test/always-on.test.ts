import { SELF, env as testEnv, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { CATALOG } from "@mano/programs";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import { zonedInstant } from "../src/deadlines.js";

// The daily check through the real worker, PersonAgent, encrypted profile and
// the Durable Object's own alarm: the clock is set, the alarm handler runs the
// schedules that are due, and what reaches Channels' agent-send route is what
// a person would get. People and incomes are synthetic.

const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(h: string, method: string, path: string, body?: unknown, token = AGENT_TOKEN) {
  const grant = await mintHandleGrant(h, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(h)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function stubFor(h: string) {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(personIdForHandle(h)));
}

function recordChannels(answer: () => Response = () => Response.json({ sent: true })) {
  const posts: { key: string; text: string }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)) as { key: string; text: string });
    return answer();
  });
  return posts;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setClock = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
};

// A local wall time on a fixed date in the person's zone, days after it.
const DAY = "2026-11-10";
const dayPlus = (days: number) => new Date(Date.parse(`${DAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const at = (days: number, hour: number, minute: number, zone: string) => zonedInstant(dayPlus(days), hour, minute, zone);
const PACIFIC = "America/Los_Angeles";

// The clock set to this instant, and the alarm handler run until the check and
// the delivery it arms have both had their turn.
async function alarmsAt(h: string, ms: number) {
  setClock(ms);
  const stub = stubFor(h);
  for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
}

let keyCount = 0;
async function patch(h: string, fields: Record<string, unknown>, source = "person") {
  const res = await call(h, "PATCH", "/profile", { idempotencyKey: `patch-${++keyCount}`, source, generation: 0, ...(source === "document" ? { documentId: "doc-1" } : {}), fields });
  return res;
}

// A household of two living on $900 a month, under every gross limit in the
// catalog for that size, in this state.
async function personIn(tag: string, state: string, more: Record<string, unknown> = {}) {
  const h = handle(tag);
  const res = await patch(h, {
    "person.address.state": state,
    "person.householdConfirmed": true,
    "household.kid.name": "Sam Example",
    "income.job.amount": 900,
    "income.job.frequency": "monthly",
    "person.alwaysOn": true,
    ...more,
  });
  expect(res.status).toBe(200);
  return h;
}

async function checkTimes(h: string): Promise<number[]> {
  return runInDurableObject(stubFor(h), async (instance) =>
    (await (instance as PersonAgent).listSchedules()).filter((s) => s.callback === "runAlwaysOnCheck").map((s) => s.time * 1000),
  );
}

const helpRows = (h: string) =>
  runInDurableObject(stubFor(h), async (_instance, state) =>
    state.storage.sql.exec("SELECT id, status FROM reminders WHERE id LIKE 'help:%' ORDER BY id").toArray() as { id: string; status: string }[],
  );

describe("the daily check", () => {
  it("runs at the nudge time in the person's zone, texts once, and a second run sends nothing", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-once", "CA");
    expect(await checkTimes(h)).toEqual([at(1, 9, 30, PACIFIC)]);

    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:CA:snap"]);
    expect(posts[0].text).toContain("you may qualify for CalFresh");
    expect(posts[0].text).toContain("household of 2");
    expect(posts[0].text).toContain("the office decides");
    expect(posts[0].text).toContain('"stop checking"');
    expect(posts[0].text).toContain("STOP to end all texts");
    expect(await helpRows(h)).toEqual([{ id: "help:g0:CA:snap", status: "sent" }]);
    // It armed the next day's check, and only that.
    expect(await checkTimes(h)).toEqual([at(2, 9, 30, PACIFIC)]);

    // The same run again the same day, then the next day's own run.
    await runInDurableObject(stubFor(h), (instance) => (instance as PersonAgent).runAlwaysOnCheck());
    await alarmsAt(h, at(1, 9, 31, PACIFIC));
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    await alarmsAt(h, at(3, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);
    // A person's own reminder list does not show it.
    const reminders = (await (await call(h, "GET", "/reminders")).json()) as { reminders: unknown[] };
    expect(reminders.reminders).toEqual([]);
  });

  it("a program the catalog gains a limit for gets one new text, once", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-new", "CA");
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:CA:snap"]);
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);

    const fact = CATALOG.CA.programs.liheap.incomeLimit!;
    const before = fact.value;
    fact.value = { ...before, measuredOn: "gross", period: "monthly", tables: [{ appliesTo: "all households", bySize: [2000, 3000], eachAdditional: 500 }] };
    try {
      await alarmsAt(h, at(3, 9, 30, PACIFIC));
      await alarmsAt(h, at(4, 9, 30, PACIFIC));
    } finally {
      fact.value = before;
    }
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:CA:snap", "reminder:help:g0:CA:liheap"]);
    expect(posts[1].text).toContain(`you may qualify for ${CATALOG.CA.programs.liheap.name!.value}`);
  });

  it("several programs at once are one text a day, and a move to another state is new", async () => {
    const posts = recordChannels();
    const zone = "America/Phoenix";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-many", "AZ");
    await alarmsAt(h, at(1, 9, 30, zone));
    expect(posts).toHaveLength(1);
    await alarmsAt(h, at(2, 9, 30, zone));
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((p) => p.key)).size).toBe(2);

    expect((await patch(h, { "person.address.state": "WA" })).status).toBe(200);
    // The check moved to the new zone. It is still today there, and today
    // already had its text.
    expect(await checkTimes(h)).toEqual([at(2, 9, 30, PACIFIC)]);
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    expect(posts).toHaveLength(2);
    await alarmsAt(h, at(3, 9, 30, PACIFIC));
    expect(posts).toHaveLength(3);
    expect(posts.at(-1)?.key).toBe("reminder:help:g0:WA:snap");
  });

  it("outside 9:00 to 20:00 local it waits for the next 9:00, and the check after it holds back", async () => {
    const posts = recordChannels();
    const zone = "America/New_York";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-quiet", "NY");
    // The alarm ran late, into the night.
    await alarmsAt(h, at(1, 22, 30, zone));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "scheduled" }]);
    // Still night at 8:59; the text goes at 9:00, in that person's zone.
    await alarmsAt(h, at(2, 8, 59, zone));
    expect(posts).toEqual([]);
    await alarmsAt(h, at(2, 9, 0, zone));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:NY:snap"]);
  });

  it("after STOP, Channels refuses, nothing is retried and the program is not raised again", async () => {
    const posts = recordChannels(() => Response.json({ sent: false, reason: "opted_out" }));
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-stop", "CA");
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);
    expect(await helpRows(h)).toEqual([{ id: "help:g0:CA:snap", status: "dropped" }]);
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    await alarmsAt(h, at(3, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);
  });

  it("stop checking removes the check, and a text still waiting is withdrawn", async () => {
    const posts = recordChannels();
    const zone = "America/New_York";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-off", "NY");
    await alarmsAt(h, at(1, 22, 30, zone));
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "scheduled" }]);

    setClock(at(1, 23, 0, zone));
    expect((await patch(h, { "person.alwaysOn": false })).status).toBe(200);
    expect(await checkTimes(h)).toEqual([]);
    await alarmsAt(h, at(2, 9, 0, zone));
    await alarmsAt(h, at(3, 9, 30, zone));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "withdrawn" }]);
  });

  it("is off unless the person turned it on, and a document cannot turn it on", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-never", "CA", { "person.alwaysOn": false });
    expect(await checkTimes(h)).toEqual([]);
    await runInDurableObject(stubFor(h), (instance) => (instance as PersonAgent).runAlwaysOnCheck());
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([]);

    const refused = await patch(handle("ao-doc"), { "person.alwaysOn": true }, "document");
    expect(refused.status).toBe(400);
  });

  it("a person outside the catalog's eight states gets nothing", async () => {
    const posts = recordChannels();
    const zone = "America/Denver";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-co", "CO");
    await alarmsAt(h, at(1, 9, 30, zone));
    await alarmsAt(h, at(2, 9, 30, zone));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([]);
  });

  it.each([
    ["no income on file", { "income.job.amount": null, "income.job.frequency": null }],
    ["an income with no frequency", { "income.job.frequency": null }],
    ["a household the person has not confirmed", { "person.householdConfirmed": null }],
    ["income over every limit", { "income.job.amount": 50000 }],
    ["the program already on their profile", { "programs.food.program": "CalFresh", "programs.food.state": "CA" }],
  ])("sends nothing with %s", async (_name, more) => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn(`ao-${++keyCount}`, "CA");
    expect((await patch(h, more)).status).toBe(200);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    expect(posts).toEqual([]);
  });

  it("a conversation delete forgets the flag and ends the check", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-delete", "CA");
    expect((await call(h, "DELETE", "/conversation", { generation: 1 }, CHANNELS_TOKEN)).status).toBe(200);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toEqual([]);
    expect(await checkTimes(h)).toEqual([]);
  });

  it("a lost schedule comes back when the agent next starts", async () => {
    recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-lost", "CA");
    await runInDurableObject(stubFor(h), async (instance) => {
      const agent = instance as PersonAgent;
      for (const s of await agent.listSchedules()) await agent.cancelSchedule(s.id);
      await agent.onStart();
    });
    expect(await checkTimes(h)).toEqual([at(1, 9, 30, PACIFIC)]);
  });
});
