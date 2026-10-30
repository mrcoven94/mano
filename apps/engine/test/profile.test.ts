import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// The person's profile through the real worker and PersonAgent: one
// structured record every form and answer reads, each leaf with its
// source and when it changed, stored encrypted in the person's SQLite.

// Must match the bindings in vitest.config.ts.
const AGENT_TOKEN = "test-agent-token-not-real";
const CHANNELS_TOKEN = "test-channels-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const SESSION_SECRET = "test-session-secret-not-real";

function handle(tag: string): string {
  return Array.from(new TextEncoder().encode(tag.padEnd(32, "0").slice(0, 32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function asAgent(handleHash: string, method: string, path: string, body?: unknown, token = AGENT_TOKEN) {
  const grant = await mintHandleGrant(handleHash, GRANT_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personIdForHandle(handleHash)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-mano-handle-grant": grant, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function asPerson(personId: string, method: string, path: string, body?: unknown, sub = personId) {
  const token = await mintSessionToken({ kind: "person", sub }, SESSION_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type Leaf = { value: unknown; source: string; documentId?: string; updatedAt: string };

async function profileOf(res: Response) {
  expect(res.status).toBe(200);
  return ((await res.json()) as { profile: Record<string, unknown> }).profile as {
    person: Record<string, Leaf> & { address: Record<string, Leaf> };
    household: ({ id: string } & Record<string, Leaf>)[];
    income: ({ id: string } & Record<string, Leaf>)[];
    programs: ({ id: string } & Record<string, Leaf>)[];
  };
}

describe("profile: one structured record of the person", () => {
  it("starts empty in the contract's shape", async () => {
    const profile = await profileOf(await asPerson("profile-empty", "GET", "/profile"));
    expect(profile).toEqual({ person: { address: {} }, household: [], income: [], programs: [] });
  });

  it("a PATCH writes leaves that a GET reads back with their source and time", async () => {
    const h = handle("profile-write");
    const res = await asAgent(h, "PATCH", "/profile", {
      idempotencyKey: "profile-write-1",
      source: "person",
      generation: 0,
      fields: {
        "person.fullName": "Rosa Testcase",
        "person.address.line1": "12 Sample Street",
        "person.address.city": "Testville",
        "person.address.state": "ut",
        "person.address.zip": "84101",
        "household.kid1.name": "Leo",
        "household.kid1.relationship": "son",
        "household.kid1.dateOfBirth": "2018-04-02",
        "income.job1.memberId": "self",
        "income.job1.source": "Diner wages",
        "income.job1.amount": 1800,
        "income.job1.frequency": "monthly",
        "programs.snap.program": "SNAP",
        "programs.snap.state": "UT",
        "programs.snap.caseNumber": "TEST-100",
      },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { changed: string[]; replayed: boolean };
    expect(out.replayed).toBe(false);
    expect(out.changed).toHaveLength(15);

    const profile = await profileOf(await asAgent(h, "GET", "/profile"));
    expect(profile.person.fullName).toEqual({ value: "Rosa Testcase", source: "person", updatedAt: expect.any(String) });
    expect(profile.person.address.state.value).toBe("UT");
    expect(profile.person.address.zip.value).toBe("84101");
    expect(profile.household).toEqual([
      {
        id: "kid1",
        name: expect.objectContaining({ value: "Leo", source: "person" }),
        relationship: expect.objectContaining({ value: "son" }),
        dateOfBirth: expect.objectContaining({ value: "2018-04-02" }),
      },
    ]);
    expect(profile.income[0].amount.value).toBe(1800);
    expect(profile.income[0].frequency.value).toBe("monthly");
    expect(profile.programs[0]).toMatchObject({ id: "snap", caseNumber: { value: "TEST-100" } });
    expect(Number.isNaN(Date.parse(profile.person.fullName.updatedAt))).toBe(false);
  });

  it("is person-bound: another person's session or grant gets 403", async () => {
    await asPerson("profile-owner", "PATCH", "/profile", {
      idempotencyKey: "owner-1",
      source: "person",
      fields: { "person.fullName": "Owner Testcase" },
    });
    expect((await asPerson("profile-owner", "GET", "/profile", undefined, "profile-intruder")).status).toBe(403);
    expect(
      (await asPerson("profile-owner", "PATCH", "/profile", { idempotencyKey: "x", source: "person", fields: {} }, "profile-intruder"))
        .status,
    ).toBe(403);
    // Channels' token opens only the conversation delete.
    expect((await asAgent(handle("profile-ch"), "GET", "/profile", undefined, CHANNELS_TOKEN)).status).toBe(403);
  });

  it("a retried PATCH answers the same and changes nothing; a reused key with other fields is refused", async () => {
    const h = handle("profile-idem");
    const body = { idempotencyKey: "idem-1", source: "person", generation: 0, fields: { "person.phone": "555-0100" } };
    const first = (await (await asAgent(h, "PATCH", "/profile", body)).json()) as { changed: string[] };
    const before = await profileOf(await asAgent(h, "GET", "/profile"));
    await new Promise((r) => setTimeout(r, 5));
    const again = await asAgent(h, "PATCH", "/profile", body);
    expect(again.status).toBe(200);
    const replay = (await again.json()) as { changed: string[]; replayed: boolean };
    expect(replay).toMatchObject({ changed: first.changed, replayed: true });
    const after = await profileOf(await asAgent(h, "GET", "/profile"));
    expect(after.person.phone).toEqual(before.person.phone);

    const reused = await asAgent(h, "PATCH", "/profile", { ...body, fields: { "person.phone": "555-0199" } });
    expect(reused.status).toBe(409);
    expect((await profileOf(await asAgent(h, "GET", "/profile"))).person.phone.value).toBe("555-0100");
  });

  it("the same value again is unchanged: its source and time stay", async () => {
    const h = handle("profile-same");
    await asAgent(h, "PATCH", "/profile", { idempotencyKey: "s1", source: "person", generation: 0, fields: { "person.county": "Salt Lake County" } });
    const before = await profileOf(await asAgent(h, "GET", "/profile"));
    const out = (await (
      await asAgent(h, "PATCH", "/profile", { idempotencyKey: "s2", source: "person", generation: 0, fields: { "person.county": "Salt Lake County" } })
    ).json()) as { changed: string[]; unchanged: string[] };
    expect(out).toMatchObject({ changed: [], unchanged: ["person.county"] });
    expect((await profileOf(await asAgent(h, "GET", "/profile"))).person.county).toEqual(before.person.county);
  });

  it("a fact read from a document carries source document and its documentId; an unknown document is refused", async () => {
    const personId = "profile-doc";
    const doc = await asPerson(personId, "POST", "/documents", { name: "pay-stub.txt", contentB64: btoa("Synthetic pay stub") });
    expect(doc.status).toBe(200);
    const { id: documentId } = (await doc.json()) as { id: string };

    const read = await asPerson(personId, "PATCH", "/profile", {
      idempotencyKey: "doc-1",
      source: "document",
      documentId,
      fields: { "income.stub1.amount": 412.5, "income.stub1.frequency": "weekly", "income.stub1.memberId": "self" },
    });
    expect(read.status).toBe(200);
    const profile = await profileOf(await asPerson(personId, "GET", "/profile"));
    expect(profile.income[0].amount).toEqual({ value: 412.5, source: "document", documentId, updatedAt: expect.any(String) });

    const unknown = await asPerson(personId, "PATCH", "/profile", {
      idempotencyKey: "doc-2",
      source: "document",
      documentId: "doc_not_here",
      fields: { "person.fullName": "Forged Name" },
    });
    expect(unknown.status).toBe(400);
    const missing = await asPerson(personId, "PATCH", "/profile", {
      idempotencyKey: "doc-3",
      source: "document",
      fields: { "person.fullName": "No Document" },
    });
    expect(missing.status).toBe(400);
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.fullName).toBeUndefined();

    // The function Mail and Forms call inside Engine records the same way.
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(personId)) as unknown as PersonAgent;
    const viaRpc = await stub.recordDocumentFacts(personId, {
      documentId,
      idempotencyKey: "doc-rpc-1",
      fields: { "person.fullName": "Rosa Testcase" },
    });
    expect(viaRpc).toMatchObject({ status: "ok", result: { changed: ["person.fullName"] } });
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.fullName).toMatchObject({
      value: "Rosa Testcase",
      source: "document",
      documentId,
    });
  });

  it("forget clears what the person names and keeps the rest", async () => {
    const h = handle("profile-forget");
    await asAgent(h, "PATCH", "/profile", {
      idempotencyKey: "f1",
      source: "person",
      generation: 0,
      fields: {
        "person.fullName": "Rosa Testcase",
        "income.a.amount": 1800,
        "income.a.frequency": "monthly",
        "income.b.amount": 200,
        "income.b.frequency": "weekly",
      },
    });
    const out = await asAgent(h, "PATCH", "/profile", { idempotencyKey: "f2", source: "person", generation: 0, fields: { income: null } });
    expect(out.status).toBe(200);
    expect(((await out.json()) as { cleared: string[] }).cleared).toEqual(["income"]);
    const profile = await profileOf(await asAgent(h, "GET", "/profile"));
    expect(profile.income).toEqual([]);
    expect(profile.person.fullName.value).toBe("Rosa Testcase");

    await asAgent(h, "PATCH", "/profile", { idempotencyKey: "f3", source: "person", generation: 0, fields: { "person.fullName": null } });
    expect((await profileOf(await asAgent(h, "GET", "/profile"))).person.fullName).toBeUndefined();
  });

  it("refuses paths and values outside the contract", async () => {
    const h = handle("profile-bad");
    const bad = async (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      (await asAgent(h, "PATCH", "/profile", { idempotencyKey: `bad-${Math.random()}`, source: "person", generation: 0, fields, ...extra })).status;
    expect(await bad({ "person.ssn": "000-00-0000" })).toBe(400);
    expect(await bad({ "person.dateOfBirth": "March 3" })).toBe(400);
    expect(await bad({ "person.address.zip": "8410" })).toBe(400);
    expect(await bad({ "income.a.amount": -5 })).toBe(400);
    expect(await bad({ "income.a.frequency": "daily" })).toBe(400);
    expect(await bad({ "household.bad id.name": "x" })).toBe(400);
    expect(await bad({ "person.fullName": "x" }, { source: "guess" })).toBe(400);
    expect(await bad({ "person.fullName": "x" }, { idempotencyKey: "" })).toBe(400);
    // A service must say which conversation generation it prepared under.
    expect((await asAgent(h, "PATCH", "/profile", { idempotencyKey: "no-gen", source: "person", fields: { "person.fullName": "x" } })).status).toBe(400);
    expect((await profileOf(await asAgent(h, "GET", "/profile"))).person).toEqual({ address: {} });
  });

  it("is stored encrypted: no value is readable in the person's SQLite", async () => {
    const personId = "profile-sealed";
    await asPerson(personId, "PATCH", "/profile", {
      idempotencyKey: "sealed-1",
      source: "person",
      fields: { "person.fullName": "Plaintextname Testcase", "person.address.line1": "77 Visible Road" },
    });
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(personId));
    const dump = await runInDurableObject(stub, async (_agent, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray() as { name: string }[];
      return tables
        .flatMap((t) => state.storage.sql.exec(`SELECT * FROM "${t.name}"`).toArray())
        .map((row) => JSON.stringify(row))
        .join("\n");
    });
    expect(dump).toContain("person.fullName");
    expect(dump).not.toContain("Plaintextname");
    expect(dump).not.toContain("Visible Road");
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.fullName.value).toBe("Plaintextname Testcase");
  });

  it("deleting the person deletes the profile, and a write prepared before the delete never lands", async () => {
    const h = handle("profile-delete");
    await asAgent(h, "PATCH", "/profile", {
      idempotencyKey: "d1",
      source: "person",
      generation: 0,
      fields: { "person.fullName": "Rosa Testcase", "household.k.name": "Leo" },
    });
    const del = await asAgent(h, "DELETE", "/conversation", { generation: 1 }, CHANNELS_TOKEN);
    expect(del.status).toBe(200);
    expect(((await del.json()) as { removed: { profileFieldsDeleted: number } }).removed.profileFieldsDeleted).toBe(2);
    expect(await profileOf(await asAgent(h, "GET", "/profile"))).toEqual({ person: { address: {} }, household: [], income: [], programs: [] });

    const late = await asAgent(h, "PATCH", "/profile", { idempotencyKey: "d2", source: "person", generation: 0, fields: { "person.fullName": "Late" } });
    expect(late.status).toBe(409);
    // The key used before the delete is gone with the profile: the new
    // conversation can write under it.
    const reused = await asAgent(h, "PATCH", "/profile", { idempotencyKey: "d1", source: "person", generation: 1, fields: { "person.county": "Testcase County" } });
    expect(reused.status).toBe(200);
    // A retried delete with the same generation removes nothing new.
    const retried = await asAgent(h, "DELETE", "/conversation", { generation: 1 }, CHANNELS_TOKEN);
    expect(((await retried.json()) as { removed: { profileFieldsDeleted: number } }).removed.profileFieldsDeleted).toBe(2);
    expect((await profileOf(await asAgent(h, "GET", "/profile"))).person.county.value).toBe("Testcase County");
  });
});

describe("profile: memory entries that clearly map become profile fields, once", () => {
  it("moves clear facts with source agent, keeps every memory, leaves ambiguous ones in memory", async () => {
    const personId = "profile-migrate";
    for (const content of ["Lives in Salt Lake County", "Has two kids", "Prefers Spanish", "SNAP case number is TEST-4417"]) {
      expect((await asPerson(personId, "POST", "/memory", { content, source: "agent" })).status).toBe(200);
    }
    const profile = await profileOf(await asPerson(personId, "GET", "/profile"));
    expect(profile.person.county).toMatchObject({ value: "Salt Lake County", source: "agent" });
    expect(profile.person.language).toMatchObject({ value: "Spanish", source: "agent" });
    expect(profile.programs).toEqual([
      expect.objectContaining({ program: expect.objectContaining({ value: "SNAP" }), caseNumber: expect.objectContaining({ value: "TEST-4417", source: "agent" }) }),
    ]);
    expect(profile.household).toEqual([]);
    const memories = ((await (await asPerson(personId, "GET", "/memory")).json()) as { memories: { content: string }[] }).memories;
    expect(memories.map((m) => m.content).sort()).toEqual(
      ["Has two kids", "Lives in Salt Lake County", "Prefers Spanish", "SNAP case number is TEST-4417"].sort(),
    );

    // Once: a field the person cleared is not brought back from memory.
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "m1", source: "person", fields: { "person.county": null } });
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.county).toBeUndefined();
  });

  it("never overwrites a fact the profile already has", async () => {
    const personId = "profile-migrate-keep";
    await asPerson(personId, "POST", "/memory", { content: "Lives in Davis County", source: "agent" });
    // The first profile call is a PATCH: the person's own words win.
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "k1", source: "person", fields: { "person.county": "Weber County" } });
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.county).toMatchObject({ value: "Weber County", source: "person" });
  });
});

describe("profile: a migrated field and its memory note are one fact", () => {
  it("forgetting the field forgets the note", async () => {
    const personId = "profile-link-field";
    await asPerson(personId, "POST", "/memory", { content: "Lives in Synthetic County", source: "agent" });
    await asPerson(personId, "POST", "/memory", { content: "Has two kids", source: "agent" });
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.county?.value).toBe("Synthetic County");
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "lf1", source: "person", fields: { "person.county": null } });
    const memories = ((await (await asPerson(personId, "GET", "/memory")).json()) as { memories: { content: string }[] }).memories;
    expect(memories.map((m) => m.content)).toEqual(["Has two kids"]);
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.county).toBeUndefined();
  });

  it("forgetting the note forgets the field", async () => {
    const personId = "profile-link-note";
    const { id } = (await (await asPerson(personId, "POST", "/memory", { content: "Lives in Synthetic County", source: "agent" })).json()) as {
      id: string;
    };
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.county?.value).toBe("Synthetic County");
    expect((await asPerson(personId, "DELETE", `/memory/${id}`)).status).toBe(200);
    expect((await profileOf(await asPerson(personId, "GET", "/profile"))).person.county).toBeUndefined();
  });

  it("the person changing a migrated field retires the old note", async () => {
    const personId = "profile-link-change";
    await asPerson(personId, "POST", "/memory", { content: "Lives in Davis County", source: "agent" });
    await asPerson(personId, "GET", "/profile");
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "lc1", source: "person", fields: { "person.county": "Weber County" } });
    const memories = ((await (await asPerson(personId, "GET", "/memory")).json()) as { memories: unknown[] }).memories;
    expect(memories).toEqual([]);
  });
});

describe("profile: person over document over agent", () => {
  async function withDocument(personId: string): Promise<string> {
    const doc = await asPerson(personId, "POST", "/documents", { name: "letter.txt", contentB64: btoa("Synthetic letter") });
    return ((await doc.json()) as { id: string }).id;
  }
  const stubOf = (personId: string) => testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(personId)) as unknown as PersonAgent;

  it("a letter's older address does not replace what the person said; it waits as a suggestion", async () => {
    const personId = "profile-trust-letter";
    const documentId = await withDocument(personId);
    await asPerson(personId, "PATCH", "/profile", {
      idempotencyKey: "t1",
      source: "person",
      fields: { "person.address.line1": "12 Sample Street", "person.address.city": "Testville" },
    });
    const out = await stubOf(personId).recordDocumentFacts(personId, {
      documentId,
      idempotencyKey: "t2",
      fields: { "person.address.line1": "4 Oak St", "person.address.city": "Testville" },
    });
    expect(out).toMatchObject({ status: "ok", result: { changed: [], suggested: ["person.address.line1"], unchanged: ["person.address.city"] } });
    const res = await asPerson(personId, "GET", "/profile");
    const body = (await res.json()) as { profile: { person: { address: Record<string, Leaf> } }; suggestions: unknown[] };
    expect(body.profile.person.address.line1).toMatchObject({ value: "12 Sample Street", source: "person" });
    expect(body.profile.person.address.city).toMatchObject({ value: "Testville", source: "person" });
    expect(body.suggestions).toEqual([
      { path: "person.address.line1", value: "4 Oak St", source: "document", documentId, suggestedAt: expect.any(String) },
    ]);

    // The person confirms: their word replaces it and the suggestion is settled.
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "t3", source: "person", fields: { "person.address.line1": "4 Oak St" } });
    const after = (await (await asPerson(personId, "GET", "/profile")).json()) as { profile: { person: { address: Record<string, Leaf> } }; suggestions: unknown[] };
    expect(after.profile.person.address.line1).toMatchObject({ value: "4 Oak St", source: "person" });
    expect(after.suggestions).toEqual([]);
  });

  it("saying the old value again settles the suggestion without applying it", async () => {
    const personId = "profile-trust-decline";
    const documentId = await withDocument(personId);
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "d1", source: "person", fields: { "person.address.zip": "84101" } });
    await stubOf(personId).recordDocumentFacts(personId, { documentId, idempotencyKey: "d2", fields: { "person.address.zip": "84000" } });
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "d3", source: "person", fields: { "person.address.zip": "84101" } });
    const body = (await (await asPerson(personId, "GET", "/profile")).json()) as { profile: { person: { address: Record<string, Leaf> } }; suggestions: unknown[] };
    expect(body.profile.person.address.zip.value).toBe("84101");
    expect(body.suggestions).toEqual([]);
  });

  it("an agent value never replaces a document's, a document replaces an agent's, and a lower source cannot clear a higher one", async () => {
    const h = handle("profile-trust-agent");
    const personId = personIdForHandle(h);
    const documentId = await withDocument(personId);
    await stubOf(personId).recordDocumentFacts(personId, { documentId, idempotencyKey: "a1", fields: { "income.job.amount": 412.5 } });
    const agentWrite = await asAgent(h, "PATCH", "/profile", {
      idempotencyKey: "a2",
      source: "agent",
      generation: 0,
      fields: { "income.job.amount": 500, "person.county": "Guess County" },
    });
    expect(((await agentWrite.json()) as { suggested: string[] }).suggested).toEqual(["income.job.amount"]);
    await stubOf(personId).recordDocumentFacts(personId, { documentId, idempotencyKey: "a3", fields: { "person.county": "Testcase County" } });
    const cleared = await asAgent(h, "PATCH", "/profile", { idempotencyKey: "a4", source: "agent", generation: 0, fields: { income: null } });
    expect(cleared.status).toBe(200);
    const profile = await profileOf(await asAgent(h, "GET", "/profile"));
    expect(profile.income[0].amount).toMatchObject({ value: 412.5, source: "document" });
    expect(profile.person.county).toMatchObject({ value: "Testcase County", source: "document" });
  });
});

describe("profile: read inside Engine", () => {
  it("getProfile(this.personId) gives Deadlines the state for the nudge timezone", async () => {
    const personId = "profile-deadlines";
    await asPerson(personId, "PATCH", "/profile", { idempotencyKey: "z1", source: "person", fields: { "person.address.state": "ut" } });
    const stub = testEnv.PERSON_AGENT.get(testEnv.PERSON_AGENT.idFromName(personId));
    const state = await runInDurableObject(stub, async (instance) => {
      const agent = instance as PersonAgent;
      return (await agent.getProfile(agent.personId))?.person.address.state?.value;
    });
    expect(state).toBe("UT");
  });
});
