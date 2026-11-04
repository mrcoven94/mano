// The renewal over many texts, through handleTurn against Engine's own
// profile store, with the model played by the tool calls a production run
// recorded (synthetic person, values verbatim). That run asked for every
// field in turn and called fill_form each time; it never called
// update_profile, and Engine's profile stayed empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor, type Profile } from "../agent/lib/engine.js";
import { FORMS, fillFrom } from "../agent/lib/forms.js";
import { presentationHash } from "../agent/lib/pending.js";
import { profileGuide, summarizeProfile } from "../agent/lib/profile.js";
import { heldOf, initialSettleState, reduceSettleEvent } from "../agent/lib/settle.js";
import { handlePresented, handleTurn, type AgentTurnInput } from "../agent/lib/turn.js";
import fillForm from "../agent/tools/fill_form.js";
import startFormDraft from "../agent/tools/start_form_draft.js";
import updateProfile from "../agent/tools/update_profile.js";
import { recordedReader } from "../../../packages/mail/test/letter-fixture.js";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const SECRET = "renewal-answers-secret";
const HANDLE = "a".repeat(64);
const PERSON = personIdFor(HANDLE);
const PHOTO = "g0t1i0-paystub00001";
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

// What she texted, in the order the form asked, as the run recorded it.
const RECORDED: [field: string, text: string][] = [
  ["caseNumber", "VE-SNAP-263507"],
  ["fullName", "Nivra Pellorin"],
  ["dateOfBirth", "03/14/1985"],
  ["householdSize", "3"],
  ["monthlyIncome", "1800"],
  ["address", "703 Frendle Path, Drelvessa, Kelvessa 00042"],
  ["phone", "(202) 555-0142"],
];

const QUESTIONS: Record<string, RegExp> = {
  caseNumber: /case number/i,
  fullName: /full legal name/i,
  dateOfBirth: /date of birth/i,
  householdSize: /how many people/i,
  monthlyIncome: /how much does your household earn/i,
  address: /mailing address/i,
  phone: /what phone number/i,
};

type Call = { tool: "fill_form" | "start_form_draft"; answers: Record<string, string> };
type Body = { status: string; text: string; approval?: string; approvalId?: string };

let engine: EngineDouble;
let grant: string;
let seen: AgentTurnInput[];
let turns: number;
let statuses: string[];

const client = () => engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!;
const person = () => client().forHandle(HANDLE, grant, 0);

function signed(path: string, body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return new Request(`http://agent.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signBody(SECRET, ts, raw) },
    body: raw,
  });
}

// The model's whole turn: its tool calls in order, then the question the
// last one told it to ask, word for word.
function modelCalling(calls: Call[]) {
  return async (input: AgentTurnInput) => {
    seen.push(input);
    if (calls.length === 0) return { status: "replied" as const, text: "Noted.", reason: "stop" };
    const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs });
    const state = initialSettleState(input.turnId);
    let output: { status?: string; question?: string; note?: string } = {};
    for (const call of calls) {
      output = (call.tool === "fill_form"
        ? await fillForm.execute({ form: "food-renewal", answers: call.answers }, ctx)
        : await startFormDraft.execute({ answers: call.answers }, ctx)) as typeof output;
      statuses.push(`${call.tool}:${output.status}`);
      reduceSettleEvent(state, { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId: "c", toolName: call.tool, output } } });
    }
    return { status: "replied" as const, text: output.question ?? output.note ?? "", reason: "stop", held: heldOf(state) };
  };
}

async function text(words: string, ...calls: Call[]): Promise<Body> {
  const res = await handleTurn(
    signed("/channels/mano/turn", { turnId: `turn_renewal_${String(++turns).padStart(4, "0")}`, generation: 0, handleHash: HANDLE, grant, receivedAt: Date.now(), texts: [words], attachmentCount: 0 }),
    { secret: SECRET, engine: client(), runAgent: modelCalling(calls) },
  );
  const body = (await res.json()) as Body;
  if (body.status === "waiting_approval") {
    await handlePresented(
      signed("/channels/mano/presented", { handleHash: HANDLE, approvalId: body.approvalId, textHash: presentationHash(body.approval!), generation: 0, grant }),
      { secret: SECRET, engine: client() },
    );
  }
  // She reads a reply before answering.
  await new Promise((r) => setTimeout(r, 3));
  return body;
}

// A photo with no words: Channels stored it, the reading fails, and the
// turn answers without the model.
async function photo(): Promise<Body> {
  engine.putDocument(PERSON, PHOTO, PNG);
  const res = await handleTurn(
    signed("/channels/mano/turn", {
      turnId: `turn_renewal_${String(++turns).padStart(4, "0")}`,
      generation: 0,
      handleHash: HANDLE,
      grant,
      receivedAt: Date.now(),
      texts: [],
      attachmentCount: 1,
      documents: [{ id: PHOTO, mimeType: "image/png" }],
    }),
    { secret: SECRET, engine: client(), runAgent: modelCalling([]), mailModel: recordedReader([]) },
  );
  await new Promise((r) => setTimeout(r, 3));
  return (await res.json()) as Body;
}

// The value a form would use now, with nothing passed: what a later call
// finds on her profile.
async function draftValue(field: string): Promise<string | undefined> {
  return fillFrom(FORMS["food-renewal"]!, (await person().getProfile())!, {}).values[field];
}

const caseOf = async (id: string) => (await person().getProfile())!.programs.find((p) => p.id === id)?.caseNumber?.value;

const askedAbout = (reply: string) => Object.keys(QUESTIONS).filter((field) => QUESTIONS[field]!.test(reply));

beforeEach(async () => {
  engine = new EngineDouble();
  seen = [];
  turns = 0;
  statuses = [];
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubEnv("MANO_PORTAL_URL", "http://portal.test");
  vi.stubGlobal("fetch", engine.fetch);
  grant = await grantFor(HANDLE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the answers she texts for her renewal", () => {
  it("land on her profile when the model passes them only to fill_form, as the production run did", async () => {
    await text("can you fill out my renewal for me", { tool: "fill_form", answers: {} });
    const answers: Record<string, string> = {};
    for (const [field, value] of RECORDED) {
      answers[field] = value;
      await text(value, { tool: "fill_form", answers: { ...answers } });
    }
    const profile = (await person().getProfile())!;
    expect(profile.person.fullName).toMatchObject({ value: "Nivra Pellorin", source: "person" });
    expect(profile.person.dateOfBirth).toMatchObject({ value: "1985-03-14", source: "person" });
    expect(profile.person.phone).toMatchObject({ value: "(202) 555-0142", source: "person" });
    expect(profile.programs.map((p) => p.caseNumber?.value)).toEqual(["VE-SNAP-263507"]);

    await text("is my renewal ready to go?");
    const told = seen.at(-1)!.context.join("\n");
    for (const value of ["VE-SNAP-263507", "Nivra Pellorin", "1985-03-14", "703 Frendle Path, Drelvessa, Kelvessa 00042", "(202) 555-0142"]) {
      expect(told).toContain(value);
    }
  });

  it("are each asked for once when the model passes only the newest answer", async () => {
    const asked = askedAbout((await text("can you fill out my renewal for me", { tool: "fill_form", answers: {} })).text);
    for (const [field, value] of RECORDED) {
      asked.push(...askedAbout((await text(value, { tool: "fill_form", answers: { [field]: value } })).text));
    }
    expect(asked).toEqual(RECORDED.map(([field]) => field));
  });

  it("carry into the draft and the filing with none of them passed again", async () => {
    await text("can you fill out my renewal for me", { tool: "fill_form", answers: {} });
    for (const [field, value] of RECORDED) await text(value, { tool: "fill_form", answers: { [field]: value } });
    await photo();

    statuses = [];
    const ready = await text("ok I sent the pay stub. please finish the renewal", { tool: "fill_form", answers: {} }, { tool: "start_form_draft", answers: {} });
    expect(statuses).toEqual(["fill_form:unavailable", "start_form_draft:waiting_for_yes"]);
    expect(ready.status).toBe("waiting_approval");
    const yes = await text("YES");
    expect(yes.text).toMatch(/^Done\./);
    expect(engine.executor.calls).toHaveLength(1);
    expect(engine.executor.calls[0]!.documentId).toBe(PHOTO);
    expect(engine.executor.calls[0]!.payload).toMatchObject({
      caseNumber: "VE-SNAP-263507",
      fullName: "Nivra Pellorin",
      dateOfBirth: "1985-03-14",
      householdSize: "3",
      monthlyIncome: "1800",
      address: "703 Frendle Path, Drelvessa, Kelvessa 00042",
      phone: "(202) 555-0142",
    });
  });
});

describe("keeping an answer", () => {
  const fill = (answers: Record<string, string>) => text("my answer", { tool: "fill_form", answers });

  it("splits an address it can, so the state on file sets her time zone", async () => {
    await fill({ address: "12 Oak St, Apt 4, Fresno, CA 93721" });
    const { address } = (await person().getProfile())!.person;
    expect([address.line1?.value, address.line2?.value, address.city?.value, address.state?.value, address.zip?.value]).toEqual(["12 Oak St", "Apt 4", "Fresno", "CA", "93721"]);
  });

  it("keeps an address it cannot split whole, and a new one leaves no old part behind", async () => {
    await fill({ address: "12 Oak St, Apt 4, Fresno, CA 93721" });
    await fill({ address: "703 Frendle Path Drelvessa Kelvessa 00042" });
    const person_ = (await person().getProfile())!.person;
    expect(person_.address.line1?.value).toBe("703 Frendle Path Drelvessa Kelvessa 00042");
    expect(person_.address.city).toBeUndefined();
    expect(person_.address.line2).toBeUndefined();
    expect(await draftValue("address")).toBe("703 Frendle Path Drelvessa Kelvessa 00042");
  });

  it("does not let part of an address replace a whole one", async () => {
    await fill({ address: "12 Oak St, Fresno, CA 93721" });
    await fill({ address: "14 Elm St" });
    expect((await person().getProfile())!.person.address.line1?.value).toBe("12 Oak St");
  });

  it("does not save an answer that does not fit its field", async () => {
    const reply = await fill({ dateOfBirth: "last spring" });
    expect(reply.text).toMatch(QUESTIONS.dateOfBirth!);
    expect((await person().getProfile())!.person.dateOfBirth).toBeUndefined();
  });

  it("takes the total she gives over the entries on file, and adds nothing to them", async () => {
    await person().patchProfile({ idempotencyKey: "seed-job", source: "person", fields: { "income.job.source": "diner", "income.job.amount": 500, "income.job.frequency": "weekly" } });
    await fill({ monthlyIncome: "1800.50" });
    expect(await draftValue("monthlyIncome")).toBe("1800.5");
  });

  it("drops the total she gave once an entry changes after it", async () => {
    await fill({ monthlyIncome: "1800" });
    await new Promise((r) => setTimeout(r, 3));
    await person().patchProfile({ idempotencyKey: "new-job", source: "person", fields: { "income.job.source": "bakery", "income.job.amount": 2000, "income.job.frequency": "monthly" } });
    expect(await draftValue("monthlyIncome")).toBe("2000");
  });

  it("lets a number she gives replace a confirmed roster that no longer matches", async () => {
    await person().patchProfile({ idempotencyKey: "seed-roster", source: "person", fields: { "household.leo.name": "Leo", "person.householdConfirmed": true } });
    expect(await draftValue("householdSize")).toBe("2");
    await fill({ householdSize: "4" });
    expect(await draftValue("householdSize")).toBe("4");
  });

  it("writes nothing when the answer is what the roster already says, so the roster stays confirmed", async () => {
    await person().patchProfile({ idempotencyKey: "seed-same", source: "person", fields: { "household.leo.name": "Leo", "person.householdConfirmed": true } });
    await fill({ householdSize: "2" });
    const profile = (await person().getProfile())!;
    expect(profile.person.householdConfirmed?.value).toBe(true);
    expect(profile.person.householdSize).toBeUndefined();
  });

  it("puts a case number on the food case already on file, and leaves another program alone", async () => {
    await person().patchProfile({ idempotencyKey: "seed-cases", source: "person", fields: { "programs.a.program": "CalFresh", "programs.a.caseNumber": "OLD-1", "programs.b.program": "Medi-Cal", "programs.b.caseNumber": "MC-9" } });
    await fill({ caseNumber: "NEW-2" });
    const byProgram = Object.fromEntries((await person().getProfile())!.programs.map((p) => [p.program?.value, p.caseNumber?.value]));
    expect(byProgram).toEqual({ CalFresh: "NEW-2", "Medi-Cal": "MC-9" });
  });

  it("takes the number she gives between two food cases, and changes neither", async () => {
    await person().patchProfile({ idempotencyKey: "seed-two", source: "person", fields: { "programs.a.program": "SNAP", "programs.a.caseNumber": "A-1", "programs.b.program": "CalFresh", "programs.b.caseNumber": "B-2" } });
    await fill({ caseNumber: "B-2" });
    expect(await draftValue("caseNumber")).toBe("B-2");
    expect(await caseOf("a")).toBe("A-1");
    expect(await caseOf("b")).toBe("B-2");
  });

  it("loses only the value Engine refuses, and the form goes on", async () => {
    const reply = await fill({ fullName: "Nivra Pellorin", phone: "call 202-555-0142" });
    expect(reply.text).toMatch(QUESTIONS.caseNumber!);
    const profile = (await person().getProfile())!;
    expect(profile.person.fullName?.value).toBe("Nivra Pellorin");
    expect(profile.person.phone).toBeUndefined();
  });

  it("goes on asking the next question when Engine cannot save at all", async () => {
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH" ? new Response("unavailable", { status: 503 }) : engine.fetch(url, init),
    );
    const reply = await fill({ caseNumber: "VE-SNAP-263507" });
    expect(reply.text).toMatch(QUESTIONS.fullName!);
  });

  it("writes one value once when a turn retries", async () => {
    const answers = { fullName: "Nivra Pellorin" };
    const again = async () =>
      handleTurn(
        signed("/channels/mano/turn", { turnId: "turn_renewal_retry", generation: 0, handleHash: HANDLE, grant, receivedAt: Date.now(), texts: ["Nivra Pellorin"], attachmentCount: 0 }),
        { secret: SECRET, engine: client(), runAgent: modelCalling([{ tool: "fill_form", answers }]) },
      );
    expect((await again()).status).toBe(200);
    const first = (await person().getProfile())!.person.fullName;
    expect((await again()).status).toBe(200);
    expect((await person().getProfile())!.person.fullName).toEqual(first);
  });

  it("is forgotten when she asks", async () => {
    await fill({ householdSize: "3", monthlyIncome: "1800", address: "703 Frendle Path, Drelvessa, Kelvessa 00042" });
    const ctx = toolCtx({ handleHash: HANDLE, turnId: "turn_renewal_forget", grant, generation: 0 });
    await updateProfile.execute({ forget: ["household", "income", "address"] }, ctx);
    const { profile } = await person().getProfileView();
    expect(profile.person.householdSize).toBeUndefined();
    expect(profile.income).toEqual([]);
    expect(profile.person.address).toEqual({});
  });

  it("shows on the summary and in what the model is told, without inventing a roster", async () => {
    await fill({ householdSize: "3" });
    const view = await person().getProfileView();
    expect(view.profile.household).toEqual([]);
    expect(summarizeProfile(view)).toContain("Household of 3");
    expect(profileGuide(view)).toContain("Household size: 3 including the person");
  });
});

describe("two food cases in two states", () => {
  const fill = (answers: Record<string, string>) => text("my answer", { tool: "fill_form", answers });
  const seed = (extra: Record<string, string> = {}) =>
    person().patchProfile({
      idempotencyKey: "seed-states",
      source: "person",
      fields: { "programs.wa.program": "SNAP", "programs.wa.state": "WA", "programs.wa.caseNumber": "WA-1", "programs.ca.program": "CalFresh", "programs.ca.state": "CA", "programs.ca.caseNumber": "CA-9", ...extra },
    });

  it("leaves the other state's case alone when she answers with no address on file, and does not ask again", async () => {
    await seed();
    await fill({ caseNumber: "WA-1" });
    expect(await caseOf("wa")).toBe("WA-1");
    expect(await caseOf("ca")).toBe("CA-9");
    expect(await draftValue("caseNumber")).toBe("WA-1");
  });

  it("uses and corrects only the case for the state she lives in", async () => {
    await seed({ "person.address.state": "WA" });
    expect(await draftValue("caseNumber")).toBe("WA-1");
    await fill({ caseNumber: "WA-2" });
    expect(await caseOf("wa")).toBe("WA-2");
    expect(await caseOf("ca")).toBe("CA-9");
    expect(await draftValue("caseNumber")).toBe("WA-2");
  });

  it("does not put a new state's number on an old state's case", async () => {
    await person().patchProfile({ idempotencyKey: "seed-moved", source: "person", fields: { "programs.wa.program": "SNAP", "programs.wa.state": "WA", "programs.wa.caseNumber": "WA-1", "person.address.state": "CA" } });
    expect(await draftValue("caseNumber")).toBeUndefined();
    await fill({ caseNumber: "CA-9" });
    expect(await caseOf("wa")).toBe("WA-1");
    expect(await draftValue("caseNumber")).toBe("CA-9");
  });

  it("lets her change her answer back after a case on file changed", async () => {
    await seed();
    await fill({ caseNumber: "WA-1" });
    await new Promise((r) => setTimeout(r, 3));
    await person().patchProfile({ idempotencyKey: "fix-wa", source: "person", fields: { "programs.wa.caseNumber": "WA-5" } });
    expect(await draftValue("caseNumber")).toBeUndefined();
    await fill({ caseNumber: "WA-5" });
    expect(await draftValue("caseNumber")).toBe("WA-5");
    expect(await caseOf("ca")).toBe("CA-9");
  });
});

describe("the monthly total she gave", () => {
  const fill = (answers: Record<string, string>) => text("my answer", { tool: "fill_form", answers });
  const tick = () => new Promise((r) => setTimeout(r, 3));

  it("gives way when only how often a job pays is corrected", async () => {
    await person().patchProfile({ idempotencyKey: "seed-weekly", source: "person", fields: { "income.job.source": "diner", "income.job.amount": 500, "income.job.frequency": "weekly" } });
    await fill({ monthlyIncome: "1800" });
    expect(await draftValue("monthlyIncome")).toBe("1800");
    await tick();
    await person().patchProfile({ idempotencyKey: "fix-monthly", source: "person", fields: { "income.job.frequency": "monthly" } });
    expect(await draftValue("monthlyIncome")).toBe("500");
  });

  it("stands again when she restates the same total after an entry changed", async () => {
    await fill({ monthlyIncome: "1800" });
    await tick();
    await person().patchProfile({ idempotencyKey: "new-job-2", source: "person", fields: { "income.job.source": "bakery", "income.job.amount": 2000, "income.job.frequency": "monthly" } });
    expect(await draftValue("monthlyIncome")).toBe("2000");
    await tick();
    await fill({ monthlyIncome: "1800" });
    expect(await draftValue("monthlyIncome")).toBe("1800");
  });

  it("is not replaced by a document read after it, which ranks below her word", async () => {
    engine.putDocument(PERSON, PHOTO, PNG);
    await fill({ monthlyIncome: "1800" });
    await tick();
    await person().patchProfile({ idempotencyKey: "stub", source: "document", documentId: PHOTO, fields: { "income.stub.source": "diner", "income.stub.amount": 900, "income.stub.frequency": "weekly" } });
    expect(await draftValue("monthlyIncome")).toBe("1800");
  });

  it("counts by its own frequency if she changes it to something other than monthly", async () => {
    await fill({ monthlyIncome: "1800" });
    await tick();
    await person().patchProfile({ idempotencyKey: "per-week", source: "person", fields: { "income.stated-monthly-total.amount": 500, "income.stated-monthly-total.frequency": "weekly" } });
    expect(await draftValue("monthlyIncome")).toBe("2167");
  });
});

describe("an answer that matches a value read from a document", () => {
  const fill = (answers: Record<string, string>) => text("my answer", { tool: "fill_form", answers });
  const fromDocument = (key: string, fields: Record<string, string | number>) => person().patchProfile({ idempotencyKey: key, source: "document", documentId: PHOTO, fields });

  beforeEach(() => engine.putDocument(PERSON, PHOTO, PNG));

  it("becomes her word, so a later document only suggests a change", async () => {
    await fromDocument("doc-1", { "person.fullName": "Maria Lopez" });
    await fill({ fullName: "Maria Lopez" });
    expect((await person().getProfile())!.person.fullName).toMatchObject({ value: "Maria Lopez", source: "person" });

    await fromDocument("doc-2", { "person.fullName": "Maria Garcia" });
    const view = await person().getProfileView();
    expect(view.profile.person.fullName).toMatchObject({ value: "Maria Lopez", source: "person" });
    expect(view.suggestions.map((s) => [s.path, s.value])).toEqual([["person.fullName", "Maria Garcia"]]);
  });

  it.each([
    ["dateOfBirth", "1985-03-14", { "person.dateOfBirth": "1985-03-14" }, (p: Profile) => p.person.dateOfBirth?.source],
    ["phone", "(202) 555-0142", { "person.phone": "(202) 555-0142" }, (p: Profile) => p.person.phone?.source],
    ["address", "12 Oak St, Fresno, CA 93721", { "person.address.line1": "12 Oak St", "person.address.city": "Fresno", "person.address.state": "CA", "person.address.zip": "93721" }, (p: Profile) => p.person.address.zip?.source],
    ["address", "703 Frendle Path, Drelvessa, Kelvessa 00042", { "person.address.line1": "703 Frendle Path, Drelvessa, Kelvessa 00042" }, (p: Profile) => p.person.address.line1?.source],
    ["caseNumber", "VE-1", { "programs.snap.program": "SNAP", "programs.snap.caseNumber": "VE-1" }, (p: Profile) => p.programs[0]?.caseNumber?.source],
  ] as [string, string, Record<string, string>, (p: Profile) => string | undefined][])("promotes %s (%s) to her word", async (field, answer, fields, sourceOf) => {
    await fromDocument(`doc-${field}`, fields);
    await fill({ [field]: answer });
    expect(sourceOf((await person().getProfile())!)).toBe("person");
  });

  it("makes a total matching a pay stub hers, so a later stub does not change it", async () => {
    await fromDocument("stub-1", { "income.stub.source": "diner", "income.stub.amount": 1800, "income.stub.frequency": "monthly" });
    await fill({ monthlyIncome: "1800" });
    await new Promise((r) => setTimeout(r, 3));
    await fromDocument("stub-2", { "income.stub.amount": 2500 });
    expect(await draftValue("monthlyIncome")).toBe("1800");
  });

  it("writes nothing when the value on file is already her word", async () => {
    await person().patchProfile({ idempotencyKey: "own", source: "person", fields: { "person.fullName": "Maria Lopez" } });
    const before = (await person().getProfile())!.person.fullName;
    const patches: string[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") patches.push(String(url));
      return engine.fetch(url, init);
    });
    await fill({ fullName: "Maria Lopez" });
    expect(patches).toEqual([]);
    expect((await person().getProfile())!.person.fullName).toEqual(before);
  });
});

describe("a household member read from a document", () => {
  it("does not change the size she confirmed when it arrives after her confirmation", async () => {
    engine.putDocument(PERSON, PHOTO, PNG);
    await person().patchProfile({ idempotencyKey: "roster", source: "person", fields: { "household.leo.name": "Leo", "person.householdConfirmed": true } });
    await new Promise((r) => setTimeout(r, 3));
    await person().patchProfile({ idempotencyKey: "doc-mia", source: "document", documentId: PHOTO, fields: { "household.mia.name": "Mia" } });
    expect(await draftValue("householdSize")).toBe("2");
    expect(profileGuide(await person().getProfileView())).toContain("Household size: 2 including the person");
  });

  it("counts once she says the list on file is everyone, even if she had confirmed before", async () => {
    engine.putDocument(PERSON, PHOTO, PNG);
    await person().patchProfile({ idempotencyKey: "roster-2", source: "person", fields: { "household.leo.name": "Leo", "person.householdConfirmed": true } });
    await new Promise((r) => setTimeout(r, 3));
    await person().patchProfile({ idempotencyKey: "doc-mia-3", source: "document", documentId: PHOTO, fields: { "household.mia.name": "Mia" } });
    await updateProfile.execute({ householdComplete: true }, toolCtx({ handleHash: HANDLE, turnId: "turn_renewal_all0", grant, generation: 0 }));
    expect(await draftValue("householdSize")).toBe("3");
  });

  it("counts when it was on the list she confirmed", async () => {
    engine.putDocument(PERSON, PHOTO, PNG);
    await person().patchProfile({ idempotencyKey: "doc-mia-2", source: "document", documentId: PHOTO, fields: { "household.mia.name": "Mia" } });
    await new Promise((r) => setTimeout(r, 3));
    await person().patchProfile({ idempotencyKey: "confirm", source: "person", fields: { "person.householdConfirmed": true } });
    expect(await draftValue("householdSize")).toBe("2");
  });

  it("becomes her word when she says the same through update_profile", async () => {
    engine.putDocument(PERSON, PHOTO, PNG);
    await person().patchProfile({ idempotencyKey: "doc-kid", source: "document", documentId: PHOTO, fields: { "household.leo.name": "Leo", "household.leo.relationship": "son" } });
    await updateProfile.execute({ household: [{ name: "Leo", relationship: "son" }] }, toolCtx({ handleHash: HANDLE, turnId: "turn_renewal_leo0", grant, generation: 0 }));
    const [leo] = (await person().getProfile())!.household;
    expect(leo!.name).toMatchObject({ value: "Leo", source: "person" });
    expect(leo!.relationship).toMatchObject({ value: "son", source: "person" });
  });
});

describe("review of f808af6: a letter never becomes her word", () => {
  const update = (input: Parameters<typeof updateProfile.execute>[0], turnId: string) =>
    updateProfile.execute(input, toolCtx({ handleHash: HANDLE, turnId, grant, generation: 0 })) as Promise<{ saved?: string[]; forgotten?: string[] }>;
  const documentNames = async (...names: string[]) => {
    engine.putDocument(PERSON, PHOTO, PNG);
    await person().patchProfile({ idempotencyKey: "doc-names", source: "document", documentId: PHOTO, fields: Object.fromEntries(names.map((n) => [`household.${n.toLowerCase()}.name`, n])) });
  };

  it("forgetting a member while saying it is just her leaves that member gone and a household of one", async () => {
    await documentNames("Eve");
    await update({ forget: ["eve"], householdComplete: true }, "turn_review_forget1");
    const profile = (await person().getProfile())!;
    expect(profile.household).toEqual([]);
    expect(profile.person.householdConfirmed?.value).toBe(true);
    expect(await draftValue("householdSize")).toBe("1");
  });

  it("forgetting the whole household while saying it is just her does the same", async () => {
    await documentNames("Eve");
    await update({ forget: ["household"], householdComplete: true }, "turn_review_forget2");
    expect((await person().getProfile())!.household).toEqual([]);
    expect(await draftValue("householdSize")).toBe("1");
  });

  it("just me and my son leaves a member only a document named as the document's, and not counted", async () => {
    await documentNames("Eve");
    await update({ household: [{ name: "Leo", relationship: "son" }], householdComplete: true }, "turn_review_leo0001");
    const profile = (await person().getProfile())!;
    expect(profile.household.find((m) => m.id === "eve")?.name?.source).toBe("document");
    expect(await draftValue("householdSize")).toBe("2");
  });

  it("confirming with no names counts no one only a document named", async () => {
    await documentNames("Eve");
    await update({ householdComplete: true }, "turn_review_conf001");
    expect((await person().getProfile())!.household[0]?.name?.source).toBe("document");
    expect(await draftValue("householdSize")).toBe("1");
  });

  it("naming a member a document gave makes that one hers and counts them", async () => {
    await documentNames("Eve", "Mia");
    await update({ household: [{ name: "Eve" }], householdComplete: true }, "turn_review_name001");
    const byName = Object.fromEntries((await person().getProfile())!.household.map((m) => [m.name?.value, m.name?.source]));
    expect(byName).toEqual({ Eve: "person", Mia: "document" });
    expect(await draftValue("householdSize")).toBe("2");
  });

  it("forget wins over naming the same member, and the size is asked rather than confirmed", async () => {
    await documentNames("Eve");
    await update({ forget: ["eve"], household: [{ ref: "eve", name: "Eve" }], householdComplete: true }, "turn_review_both001");
    const profile = (await person().getProfile())!;
    expect(profile.household).toEqual([]);
    expect(profile.person.householdConfirmed).toBeUndefined();
    expect(await draftValue("householdSize")).toBeUndefined();
  });
});

describe("review of f808af6: a case number belongs to one state", () => {
  const fill = (answers: Record<string, string>) => text("my answer", { tool: "fill_form", answers });
  const update = (input: Parameters<typeof updateProfile.execute>[0], turnId: string) =>
    updateProfile.execute(input, toolCtx({ handleHash: HANDLE, turnId, grant, generation: 0 }));
  const WA = "12 Pine St, Tacoma, WA 98401";
  const CA = "12 Oak St, Fresno, CA 93721";

  it("does not carry a number to a new state's renewal", async () => {
    await fill({ address: WA, caseNumber: "WA-1" });
    expect(await draftValue("caseNumber")).toBe("WA-1");
    await update({ person: { address: { line1: "12 Oak St", city: "Fresno", state: "CA", zip: "93721" } } }, "turn_review_move001");
    expect(await draftValue("caseNumber")).toBeUndefined();
  });

  it("does not put a number given before any state on a later state's renewal", async () => {
    await fill({ caseNumber: "WA-1" });
    await update({ person: { address: { line1: "12 Oak St", city: "Fresno", state: "CA", zip: "93721" } } }, "turn_review_move002");
    expect(await draftValue("caseNumber")).toBeUndefined();
  });

  it("uses the older case on file for the state she moved to", async () => {
    await person().patchProfile({ idempotencyKey: "older-ca", source: "person", fields: { "programs.ca.program": "CalFresh", "programs.ca.state": "CA", "programs.ca.caseNumber": "CA-OLD", "person.address.state": "WA" } });
    await fill({ caseNumber: "WA-1" });
    await update({ person: { address: { state: "CA" } } }, "turn_review_move003");
    expect(await draftValue("caseNumber")).toBe("CA-OLD");
    expect(await caseOf("ca")).toBe("CA-OLD");
  });

  it("asks when the state is no longer known", async () => {
    await fill({ address: WA, caseNumber: "WA-1" });
    await update({ forget: ["address"] }, "turn_review_forgeta");
    expect(await draftValue("caseNumber")).toBeUndefined();
  });

  it("routes a number by an address given in the same call", async () => {
    await person().patchProfile({ idempotencyKey: "wa-case", source: "person", fields: { "person.address.state": "WA", "programs.wa.program": "SNAP", "programs.wa.state": "WA", "programs.wa.caseNumber": "WA-1" } });
    await fill({ caseNumber: "CA-9", address: CA });
    expect(await caseOf("wa")).toBe("WA-1");
    expect(await draftValue("caseNumber")).toBe("CA-9");
  });

  it("does not read another state's number for a call that gives a new address", async () => {
    await person().patchProfile({ idempotencyKey: "wa-case-2", source: "person", fields: { "person.address.state": "WA", "programs.wa.program": "SNAP", "programs.wa.state": "WA", "programs.wa.caseNumber": "WA-1" } });
    const reply = await fill({ address: CA, fullName: "Nivra Pellorin", dateOfBirth: "03/14/1985", householdSize: "3", monthlyIncome: "1800", phone: "(202) 555-0142" });
    expect(reply.text).toMatch(QUESTIONS.caseNumber!);
  });

  it("update_profile does not put a number on another state's case", async () => {
    await person().patchProfile({ idempotencyKey: "wa-case-3", source: "person", fields: { "person.address.state": "CA", "programs.wa.program": "SNAP", "programs.wa.state": "WA", "programs.wa.caseNumber": "WA-1" } });
    await update({ programs: [{ program: "SNAP", caseNumber: "CA-9" }] }, "turn_review_prog001");
    expect(await caseOf("wa")).toBe("WA-1");
    expect(await draftValue("caseNumber")).toBe("CA-9");
  });

  it("reads the state from an address with no commas", async () => {
    await fill({ address: "12 Oak St Fresno CA 93721", caseNumber: "CA-9" });
    const { address } = (await person().getProfile())!.person;
    expect(address.state?.value).toBe("CA");
    expect(await draftValue("address")).toBe("12 Oak St Fresno CA 93721");
    expect(await draftValue("caseNumber")).toBe("CA-9");
  });
});

describe("review of f808af6: a total she corrected does not come back", () => {
  const fill = (answers: Record<string, string>) => text("my answer", { tool: "fill_form", answers });
  const update = (input: Parameters<typeof updateProfile.execute>[0], turnId: string) =>
    updateProfile.execute(input, toolCtx({ handleHash: HANDLE, turnId, grant, generation: 0 })) as Promise<{ forgotten?: string[] }>;

  it("asks after the job that replaced it is forgotten", async () => {
    await fill({ monthlyIncome: "1800" });
    await update({ income: [{ source: "bakery", amount: 2000, frequency: "monthly" }] }, "turn_review_job0001");
    expect(await draftValue("monthlyIncome")).toBe("2000");
    const job = (await person().getProfile())!.income.find((i) => i.source?.value === "bakery")!;
    await update({ forget: [job.id] }, "turn_review_job0002");
    expect(await draftValue("monthlyIncome")).toBeUndefined();
  });

  it("asks when a job on file is forgotten after she gave the total", async () => {
    await update({ income: [{ source: "bakery", amount: 2000, frequency: "monthly" }] }, "turn_review_job0003");
    const job = (await person().getProfile())!.income[0]!;
    await fill({ monthlyIncome: "1800" });
    await update({ forget: [job.id] }, "turn_review_job0004");
    expect(await draftValue("monthlyIncome")).toBeUndefined();
  });

  it("gives way to a frequency corrected through update_profile, and restating brings it back", async () => {
    await update({ income: [{ source: "diner", amount: 500, frequency: "weekly" }] }, "turn_review_job0005");
    const job = (await person().getProfile())!.income[0]!;
    await fill({ monthlyIncome: "1800" });
    expect(await draftValue("monthlyIncome")).toBe("1800");
    const out = await update({ income: [{ ref: job.id, frequency: "monthly" }] }, "turn_review_job0006");
    expect(await draftValue("monthlyIncome")).toBe("500");
    expect(out.forgotten).toEqual([]);
    await fill({ monthlyIncome: "1800" });
    expect(await draftValue("monthlyIncome")).toBe("1800");
  });
});

describe("a photo Mano could not read", () => {
  it("is known to the model on the next turn as arrived and on file", async () => {
    const reply = await photo();
    expect(reply.text).toMatch(/could not finish reading/i);
    expect(seen).toHaveLength(0);

    await text("ok I sent the pay stub. please finish the renewal");
    const told = seen.at(-1)!.context.join("\n");
    expect(told).toMatch(/- the \w+ you sent on \w+ \d+: can be attached to a filing/);
    expect(told).toMatch(/never say one did not arrive/i);
    expect(told).toMatch(/say it is on file and you could not read it/i);
  });

  it("leaves the model told nothing about photos when none arrived, so saying none came is true", async () => {
    await text("ok I sent the pay stub");
    expect(seen.at(-1)!.context.join("\n")).not.toMatch(/photo/i);
  });
});
