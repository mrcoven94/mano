// The renewal over many texts, through handleTurn against Engine's own
// profile store, with the model played by the tool calls a production run
// recorded (synthetic person, values verbatim). That run asked for every
// field in turn and called fill_form each time; it never called
// update_profile, and Engine's profile stayed empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "../agent/lib/auth.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
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

// The model's whole turn: the one recorded tool call, then the question
// the tool told it to ask, word for word.
function modelCalling(call: Call | null) {
  return async (input: AgentTurnInput) => {
    seen.push(input);
    if (!call) return { status: "replied" as const, text: "Noted.", reason: "stop" };
    const ctx = toolCtx({ handleHash: input.handleHash, turnId: input.turnId, grant: input.grant, generation: input.generation, turnAtMs: input.turnAtMs });
    const state = initialSettleState(input.turnId);
    const output = (call.tool === "fill_form"
      ? await fillForm.execute({ form: "food-renewal", answers: call.answers }, ctx)
      : await startFormDraft.execute({ answers: call.answers }, ctx)) as { question?: string; note?: string };
    reduceSettleEvent(state, { type: "action.result", data: { status: "completed", result: { kind: "tool-result", callId: "c", toolName: call.tool, output } } });
    return { status: "replied" as const, text: output.question ?? output.note ?? "", reason: "stop", held: heldOf(state) };
  };
}

async function text(words: string, call: Call | null = null): Promise<Body> {
  const res = await handleTurn(
    signed("/channels/mano/turn", { turnId: `turn_renewal_${String(++turns).padStart(4, "0")}`, generation: 0, handleHash: HANDLE, grant, receivedAt: Date.now(), texts: [words], attachmentCount: 0 }),
    { secret: SECRET, engine: client(), runAgent: modelCalling(call) },
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
    { secret: SECRET, engine: client(), runAgent: modelCalling(null), mailModel: recordedReader([]) },
  );
  await new Promise((r) => setTimeout(r, 3));
  return (await res.json()) as Body;
}

// The value a form would use now, with nothing passed: what a later call
// finds on her profile.
async function draftValue(field: string): Promise<string | undefined> {
  return fillFrom(FORMS["food-renewal"]!, (await person().getProfile())!, {}).values[field];
}

const askedAbout = (reply: string) => Object.keys(QUESTIONS).filter((field) => QUESTIONS[field]!.test(reply));

beforeEach(async () => {
  engine = new EngineDouble();
  seen = [];
  turns = 0;
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

    const ready = await text("ok I sent the pay stub. please finish the renewal", { tool: "start_form_draft", answers: {} });
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

  it("settles two food cases on the one number she gives", async () => {
    await person().patchProfile({ idempotencyKey: "seed-two", source: "person", fields: { "programs.a.program": "SNAP", "programs.a.caseNumber": "A-1", "programs.b.program": "CalFresh", "programs.b.caseNumber": "B-2" } });
    await fill({ caseNumber: "B-2" });
    expect(await draftValue("caseNumber")).toBe("B-2");
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
        { secret: SECRET, engine: client(), runAgent: modelCalling({ tool: "fill_form", answers }) },
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
