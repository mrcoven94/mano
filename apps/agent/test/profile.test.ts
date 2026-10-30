import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engineFromEnv, personIdFor, type Profile } from "../agent/lib/engine.js";
import profileInstruction from "../agent/instructions/profile.js";
import readProfile from "../agent/tools/read_profile.js";
import updateProfile from "../agent/tools/update_profile.js";
import remember from "../agent/tools/remember.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

// The profile through the agent's tools and turn-start instructions,
// against an Engine double built from Engine's own profile store.

const HANDLE = "d".repeat(64);
let engine: EngineDouble;
let grant: string;

const ctxFor = (turnId: string, generation = 0) => toolCtx({ handleHash: HANDLE, turnId, grant, generation }) as never;
type Update = Parameters<typeof updateProfile.execute>[0];
const update = (input: Update, turnId = "turn_profile0001") => updateProfile.execute(input, ctxFor(turnId)) as Promise<{
  saved: string[];
  forgotten?: string[];
  alreadyOnFile?: string[];
  problem?: string;
}>;

async function stored(): Promise<Profile> {
  return engineFromEnv()!.forHandle(HANDLE, grant, 0).getProfile();
}

// What the model is told about the profile when a turn starts.
async function toldAtTurnStart(): Promise<string | null> {
  const resolve = (profileInstruction as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<unknown>> }).events[
    "turn.started"
  ];
  const out = (await resolve({}, ctxFor("turn_profile0099"))) as { content?: string } | null;
  return out?.content ?? null;
}

beforeEach(async () => {
  engine = new EngineDouble();
  grant = await grantFor(HANDLE);
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubGlobal("fetch", engine.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("update_profile", () => {
  it("saves what the person said with source person and names what changed", async () => {
    const out = await update({
      person: { fullName: "Rosa Testcase", address: { line1: "12 Sample Street", city: "Testville", state: "UT", zip: "84101" } },
      household: [{ name: "Leo", relationship: "son", dateOfBirth: "2018-04-02" }],
    });
    expect(out.saved.sort()).toEqual(["Leo", "Leo's date of birth", "Leo's relationship", "address", "name"].sort());
    const profile = await stored();
    expect(profile.person.fullName).toMatchObject({ value: "Rosa Testcase", source: "person" });
    expect(profile.person.address.zip).toMatchObject({ value: "84101", source: "person" });
    expect(profile.household).toHaveLength(1);
    expect(profile.household[0].relationship).toMatchObject({ value: "son", source: "person" });
  });

  it("a retried turn writes the same entry once, and a later turn updates the same member in place", async () => {
    const leo = { household: [{ name: "Leo", relationship: "son" }] };
    expect((await update(leo)).saved.sort()).toEqual(["Leo", "Leo's relationship"]);
    const retry = await update(leo);
    expect(retry).toMatchObject({ saved: [], alreadyOnFile: ["Leo's relationship"] });
    expect((await stored()).household).toHaveLength(1);

    const later = await update({ household: [{ name: "leo", dateOfBirth: "2018-04-02" }] }, "turn_profile0002");
    expect(later.saved).toEqual(["Leo's date of birth"]);
    const household = (await stored()).household;
    expect(household).toHaveLength(1);
    expect(household[0].dateOfBirth?.value).toBe("2018-04-02");
    expect(household[0].name?.value).toBe("Leo");
  });

  it("saying the same thing again changes nothing", async () => {
    await update({ person: { county: "Salt Lake County" } });
    const before = (await stored()).person.county;
    const again = await update({ person: { county: "Salt Lake County" } }, "turn_profile0003");
    expect(again).toMatchObject({ saved: [], alreadyOnFile: ["county"] });
    expect((await stored()).person.county).toEqual(before);
  });

  it("ties income to a household member by name, and refuses one who is not on file", async () => {
    await update({
      household: [{ name: "Ana", relationship: "partner" }],
      income: [
        { member: "Ana", source: "Grocery store wages", amount: 600, frequency: "biweekly" },
        { member: "self", source: "Diner wages", amount: 1800, frequency: "monthly" },
      ],
    });
    const profile = await stored();
    const ana = profile.household.find((m) => m.name?.value === "Ana")!;
    expect(profile.income.map((i) => i.memberId?.value).sort()).toEqual([ana.id, "self"].sort());

    const out = await update({ income: [{ member: "Sam", amount: 100, frequency: "weekly" }] }, "turn_profile0004");
    expect(out.problem).toMatch(/Sam is not in the household/);
    expect((await stored()).income).toHaveLength(2);
  });

  it("forget my income clears income and keeps the rest", async () => {
    await update({ person: { fullName: "Rosa Testcase" }, income: [{ member: "self", source: "Diner wages", amount: 1800, frequency: "monthly" }] });
    const out = await update({ forget: ["income"] }, "turn_profile0005");
    expect(out.forgotten).toEqual(["income"]);
    const profile = await stored();
    expect(profile.income).toEqual([]);
    expect(profile.person.fullName?.value).toBe("Rosa Testcase");
    expect((await update({ forget: ["shoe size"] }, "turn_profile0006")).problem).toMatch(/not something on file/);
  });

  it("is refused when Engine is not configured or the turn has no grant", async () => {
    await expect(updateProfile.execute({ person: { county: "X County" } }, toolCtx({ handleHash: HANDLE, turnId: "turn_profile0007" }) as never)).rejects.toThrow(
      /not available/,
    );
  });
});

describe("the profile at the start of every turn", () => {
  it("puts every field on file in front of the model, so it never asks for one it has", async () => {
    expect(await toldAtTurnStart()).toBeNull();
    await update({
      person: { fullName: "Rosa Testcase", phone: "555-0100", address: { line1: "12 Sample Street", city: "Testville", state: "UT", zip: "84101" } },
      household: [{ name: "Leo", relationship: "son" }],
    });
    const told = (await toldAtTurnStart())!;
    expect(told).toContain("Address: 12 Sample Street, Testville, UT 84101");
    expect(told).toContain("Phone: 555-0100");
    expect(told).toMatch(/never ask for any of it again/);
    expect(told).toContain("Household size on file: 2");
    // What is missing is named, so the model asks only for that.
    expect(told).toMatch(/Not on file yet: date of birth, email, county, language\./);
    expect(told).not.toMatch(/Not on file yet:.*address/);
  });

  it("marks facts moved from older memory as not yet confirmed", async () => {
    await remember.execute({ fact: "Lives in Salt Lake County" }, ctxFor("turn_profile0008"));
    const told = (await toldAtTurnStart())!;
    expect(told).toMatch(/County: Salt Lake County \(from earlier notes; confirm before relying on it\)/);
    expect(engine.memoryOf(personIdFor(HANDLE))).toEqual(["Lives in Salt Lake County"]);
  });
});

describe("what do you have on me?", () => {
  it("answers with a short, plain summary and no internal refs", async () => {
    expect(((await readProfile.execute({}, ctxFor("turn_profile0009"))) as { summary: string }).summary).toBe(
      "I don't have anything saved about you yet.",
    );
    await update({
      person: { fullName: "Rosa Testcase", address: { line1: "12 Sample Street", city: "Testville", state: "UT", zip: "84101" } },
      household: [{ name: "Leo", relationship: "son" }],
      income: [{ member: "self", source: "Diner wages", amount: 1800, frequency: "monthly" }],
      programs: [{ program: "SNAP", state: "UT", caseNumber: "TEST-100" }],
    });
    const { summary } = (await readProfile.execute({}, ctxFor("turn_profile0010"))) as { summary: string };
    expect(summary).toBe(
      "Here is what I have on you: Rosa Testcase. 12 Sample Street, Testville, UT 84101. Household: Leo (son). Income: Diner wages, $1,800 a month (you). SNAP case TEST-100.",
    );
    expect(summary).not.toMatch(/\[/);
  });
});

describe("deleting the conversation", () => {
  it("deletes the profile with it", async () => {
    await update({ person: { fullName: "Rosa Testcase" } });
    await engineFromEnv()!.forHandle(HANDLE, grant, 1).advanceConversation();
    expect(await stored()).toEqual({ person: { address: {} }, household: [], income: [], programs: [] });
  });
});
