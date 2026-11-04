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
  const posts: { key: string; text: string; noReplay?: boolean }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)) as { key: string; text: string; noReplay?: boolean });
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

// As wrangler.toml ships it: MANO_DAILY_CHECK_SENDS unset or anything but "on".
function checkSends(h: string, value: string | undefined) {
  return runInDurableObject(stubFor(h), (instance) => {
    (instance as unknown as { env: Record<string, unknown> }).env.MANO_DAILY_CHECK_SENDS = value;
  });
}

describe("MANO_DAILY_CHECK_SENDS", () => {
  afterEach(() => {
    (testEnv as unknown as Record<string, unknown>).MANO_DAILY_CHECK_SENDS = "on";
  });

  it.each([undefined, "off", "true", ""])("as %j the check runs and sends nothing, marks nothing raised, and sends once it is on", async (value) => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn(`ao-flag-${String(value)}-x`, "CA");
    await checkSends(h, value);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([]);
    expect(await checkTimes(h)).toEqual([at(2, 9, 30, PACIFIC)]);

    await checkSends(h, "on");
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:CA:snap"]);
  });

  it("turned off with a text already waiting, holds it without raising or losing it", async () => {
    const posts = recordChannels();
    const zone = "America/New_York";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-flag-held", "NY");
    await checkSends(h, "on");
    await alarmsAt(h, at(1, 22, 30, zone));
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "scheduled" }]);
    await checkSends(h, "off");
    await alarmsAt(h, at(2, 9, 0, zone));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "scheduled" }]);
    await checkSends(h, "on");
    await alarmsAt(h, at(3, 9, 0, zone));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:NY:snap"]);
  });

  it("a deadline's nudge goes either way", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-flag-nudge", "CA");
    await checkSends(h, "off");
    const made = await call(h, "POST", "/deadlines", { title: "CalFresh renewal", dueDate: dayPlus(1), program: "CalFresh", kind: "renewal", source: { kind: "person" }, idempotencyKey: "flag-nudge", generation: 0 });
    expect(made.status).toBe(201);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts.map((p) => p.key.split(":")[1])).toEqual(["nudge"]);
  });
});

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
    // That morning's own check does not add another text on top of it.
    await alarmsAt(h, at(2, 9, 30, zone));
    expect(posts).toHaveLength(1);
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

  // The household as PR 153 defines it: who the person named, by any leaf.
  async function letter(h: string, key: string, fields: Record<string, unknown>) {
    const out = await runInDurableObject(stubFor(h), async (instance, state) => {
      state.storage.sql.exec("INSERT OR IGNORE INTO documents(id, name, hash, r2_key) VALUES ('doc-1', 'letter.txt', 'h', 'k')");
      return (instance as PersonAgent).recordDocumentFacts(personIdForHandle(h), { documentId: "doc-1", idempotencyKey: key, fields });
    });
    expect(out.status).toBe("ok");
  }
  const single = (income: number) => ({ "person.address.state": "CA", "person.householdConfirmed": true, "income.job.amount": income, "income.job.frequency": "monthly", "person.alwaysOn": true });

  it("a letter that adds someone does not widen the screen, and confirming again does not count them until the person names them", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    // Confirmed single at $2,000 a month: over CalFresh's lowest limit for one
    // ($1,729), under it for two ($2,345).
    const h = handle("ao-letter");
    expect((await patch(h, single(2000))).status).toBe(200);
    await letter(h, "letter-1", { "household.child.name": "Sam Example" });
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toEqual([]);

    setClock(at(1, 12, 0, PACIFIC));
    expect((await patch(h, { "person.householdConfirmed": true })).status).toBe(200);
    await alarmsAt(h, at(2, 9, 30, PACIFIC));
    expect(posts).toEqual([]);

    setClock(at(2, 12, 0, PACIFIC));
    expect((await patch(h, { "household.child.name": "Sam Example" })).status).toBe(200);
    await alarmsAt(h, at(3, 9, 30, PACIFIC));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:CA:snap"]);
    expect(posts[0].text).toContain("household of 2");
  });

  it("a member a letter names is not counted, with or without a name", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = handle("ao-uncounted");
    await patch(h, single(900));
    await letter(h, "uncounted", { "household.named.name": "Sam Example", "household.nameless.relationship": "child" });
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("household of 1");
  });

  it("a member the person vouched for stays counted when a later letter corrects their name", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = handle("ao-corrected-name");
    await patch(h, single(2000));
    await letter(h, "sam-1", { "household.sam.name": "Sam Example" });
    setClock(at(0, 13, 0, PACIFIC));
    // They said who Sam is without restating the name, so the name stays the letter's.
    expect((await patch(h, { "household.sam.relationship": "son" })).status).toBe(200);
    setClock(at(0, 14, 0, PACIFIC));
    await letter(h, "sam-2", { "household.sam.name": "Samuel Example" });
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("household of 2");
  });

  it("a number the person gave counts as the household", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = handle("ao-number");
    await patch(h, { "person.address.state": "CA", "person.householdSize": 2, "income.job.amount": 2000, "income.job.frequency": "monthly", "person.alwaysOn": true });
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("household of 2");
  });

  it("a number the person's newly named member retired leaves no size, so no text", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = handle("ao-retired");
    await patch(h, { "person.address.state": "CA", "person.householdSize": 2, "income.job.amount": 2000, "income.job.frequency": "monthly", "person.alwaysOn": true });
    // What update_profile writes when they name someone new after giving a number.
    expect((await patch(h, { "household.sam.name": "Sam Example", "person.householdSize": null })).status).toBe(200);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toEqual([]);
  });

  it("a confirmation in flight when a letter adds someone does not count them", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = handle("ao-inflight");
    const personId = personIdForHandle(h);
    await patch(h, { "person.address.state": "CA", "income.job.amount": 2000, "income.job.frequency": "monthly", "person.alwaysOn": true });
    const out = await runInDurableObject(stubFor(h), async (instance, state) => {
      const agent = instance as PersonAgent;
      state.storage.sql.exec("INSERT INTO documents(id, name, hash, r2_key) VALUES ('doc-1', 'letter.txt', 'h', 'k')");
      const real = crypto.subtle.encrypt.bind(crypto.subtle);
      let landed = false;
      // The confirmation is waiting on its seal when the letter's write lands.
      const spy = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
        if (!landed) {
          landed = true;
          const written = await agent.recordDocumentFacts(personId, { documentId: "doc-1", idempotencyKey: "inflight-letter", fields: { "household.child.name": "Sam Example" } });
          expect(written.status).toBe("ok");
        }
        return real(...args);
      });
      const answer = await agent.patchProfile(personId, { idempotencyKey: "inflight-yes", source: "person", fields: { "person.householdConfirmed": true } });
      spy.mockRestore();
      return answer;
    });
    expect(out.status).toBe("ok");
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts).toEqual([]);
  });

  it("marks its text no replay, and a deadline's nudge keeps Channels' retries", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-marked", "CA");
    const made = await call(h, "POST", "/deadlines", {
      title: "CalFresh renewal",
      dueDate: dayPlus(1),
      program: "CalFresh",
      kind: "renewal",
      source: { kind: "person" },
      idempotencyKey: "marked",
      generation: 0,
    });
    expect(made.status).toBe(201);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    const help = posts.find((p) => p.key.startsWith("reminder:help:"));
    const nudge = posts.find((p) => p.key.startsWith("reminder:nudge:"));
    expect(help?.noReplay).toBe(true);
    expect(nudge).toBeDefined();
    expect(nudge?.noReplay).toBeUndefined();
  });

  it("a text held overnight is withdrawn when a correction means it no longer fits", async () => {
    const posts = recordChannels();
    const zone = "America/New_York";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-corrected", "NY");
    await alarmsAt(h, at(1, 22, 30, zone));
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "scheduled" }]);

    setClock(at(1, 23, 0, zone));
    expect((await patch(h, { "income.job.amount": 50000 })).status).toBe(200);
    await alarmsAt(h, at(2, 9, 0, zone));
    expect(posts).toEqual([]);
    expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "withdrawn" }]);
  });

  it("a text held overnight says the household as it is when it goes", async () => {
    const posts = recordChannels();
    const zone = "America/New_York";
    setClock(at(0, 12, 0, zone));
    const h = await personIn("ao-grew", "NY");
    await alarmsAt(h, at(1, 22, 30, zone));
    setClock(at(1, 23, 0, zone));
    expect((await patch(h, { "household.baby.name": "Lee Example" })).status).toBe(200);
    await alarmsAt(h, at(2, 9, 0, zone));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:NY:snap"]);
    expect(posts[0].text).toContain("household of 3");
  });

  // A write that lands while delivery is waiting on decryption, at each point
  // it could: the k-th decryption after the claim runs the write first.
  const racing = [
    ["stop checking", { "person.alwaysOn": false }],
    ["an income correction", { "income.job.amount": 50000 }],
  ] as const;
  describe.each(racing)("%s landing while delivery decrypts", (name, fields) => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("at decryption %i: never sent", async (k) => {
      const posts = recordChannels();
      const zone = "America/New_York";
      setClock(at(0, 12, 0, zone));
      const h = await personIn(`ao-race-${name.length}-${k}-x`, "NY");
      await alarmsAt(h, at(1, 22, 30, zone));
      setClock(at(2, 9, 0, zone));

      const personId = personIdForHandle(h);
      let landed = false;
      await runInDurableObject(stubFor(h), async (instance) => {
        const agent = instance as PersonAgent;
        const real = crypto.subtle.decrypt.bind(crypto.subtle);
        let seen = 0;
        const spy = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
          // Two AES calls per sealed leaf: the second opens the value.
          if (!landed && ++seen === k) {
            landed = true;
            const out = await agent.patchProfile(personId, { idempotencyKey: `race-${k}`, source: "person", fields });
            expect(out.status).toBe("ok");
          }
          return real(...args);
        });
        await agent.deliverDueReminders();
        spy.mockRestore();
      });
      expect(landed).toBe(true);
      // Whatever the first run held back, the next run settles.
      await alarmsAt(h, at(2, 9, 0, zone));
      expect(posts).toEqual([]);
      expect(await helpRows(h)).toEqual([{ id: "help:g0:NY:snap", status: "withdrawn" }]);
    });
  });

  it("the alarm that wakes an evicted agent still runs the check that is due", async () => {
    const posts = recordChannels();
    setClock(at(0, 12, 0, PACIFIC));
    const h = await personIn("ao-wake", "CA");
    // A wake runs onStart before the alarm's jobs, and a request can land first.
    setClock(at(1, 9, 30, PACIFIC));
    await runInDurableObject(stubFor(h), (instance) => (instance as PersonAgent).onStart());
    expect((await patch(h, { "person.language": "English" })).status).toBe(200);
    await alarmsAt(h, at(1, 9, 30, PACIFIC));
    expect(posts.map((p) => p.key)).toEqual(["reminder:help:g0:CA:snap"]);
    expect(await checkTimes(h)).toEqual([at(2, 9, 30, PACIFIC)]);
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
