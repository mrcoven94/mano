import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import startFormDraft from "../agent/tools/start_form_draft.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { readTextedPhotos } from "../agent/lib/letters.js";
import { FORMS, fillFrom } from "../agent/lib/forms.js";
import type { Profile } from "../agent/lib/engine.js";
import { heldBack, presentsExactly, renderQuestion, waitingFrom } from "../agent/lib/pending.js";
import { SandboxExecutor, createExecutor } from "../../engine/src/gateway/executors.js";
import { DOUBTFUL_PAGE, RENEWAL_PAGE, letterPhoto, recordedReader } from "../../../packages/mail/test/letter-fixture.js";
import { DEFAULT_CONFIG, handleRequest } from "../../sandbox-portal/src/app";
import { DECLARATION } from "../../sandbox-portal/src/store";
import { MemoryFileStore, MemoryStore } from "../../sandbox-portal/test/memory-store";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "d".repeat(64);
const PERSON = personIdFor(HANDLE);
// Her answers, as the model passes them on: every field, by name.
const fields: Record<string, string> = {
  caseNumber: "WA-SNAP-0042117",
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "253-555-0100",
  householdSize: "3",
  monthlyIncome: "1800",
};

// A one-pixel PNG: the photo of her renewal letter Channels stored.
const LETTER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const LETTER_BYTES = Uint8Array.from(atob(LETTER_PNG), (c) => c.charCodeAt(0));
// A phone photo in a format the sandbox portal does not take.
const HEIC_BYTES = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic synthetic photo")]);
// A synthetic pay stub as a PDF, small enough for the portal.
const STUB_PDF = new TextEncoder().encode("%PDF-1.4 synthetic pay stub");
// A 6 MiB phone photo: Engine stores up to 10 MB, the portal takes 5 MiB.
const BIG_PNG = new Uint8Array(6 * 1024 * 1024);
BIG_PNG.set(LETTER_BYTES);
const PORTAL_TOKEN = "portal-test-token";
// 10 AM in Los Angeles on November 2, 2026.
const NOV_2 = Date.UTC(2026, 10, 2, 18, 0);

let engine: EngineDouble;
let outside: string[];
let grant: string;

const client = (generation = 0) =>
  engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, generation);

// The turn handler records each turn in Engine's ledger before the model
// runs; a draft names its turn, and Engine orders drafts by it.
async function ctx(turnId: string, turnAtMs = Date.now(), generation = 0) {
  await client(generation).putTurn(turnId, new Date(turnAtMs).toISOString());
  return toolCtx({ handleHash: HANDLE, turnId, grant, turnAtMs, generation });
}

async function draft(turnId: string, input = fields, turnAtMs?: number, generation?: number) {
  return (await startFormDraft.execute({ answers: input }, await ctx(turnId, turnAtMs, generation))) as Record<string, unknown>;
}

const frozenDocument = () => JSON.parse(engine.approvals().at(-1)!.requestJson).documentId as string;

// What Channels does with a texted photo: Engine stores it for the
// person and records when it arrived.
function photoOnFile(documentId: string, bytes: Uint8Array, atMs = Date.now(), person = PERSON) {
  const now = engine.now;
  engine.now = () => atMs;
  try {
    engine.putDocument(person, documentId, bytes);
  } finally {
    engine.now = now;
  }
}

// What Mail does with a texted letter whose deadline it publishes: the
// photo is stored, and the deadline read from it names it. Engine keeps
// one deadline per date and sentence, however often the letter is sent.
async function letterOnFile(documentId: string, bytes: Uint8Array, dueDate = "2026-12-01", atMs = Date.now()) {
  photoOnFile(documentId, bytes, atMs);
  const now = engine.now;
  engine.now = () => atMs;
  try {
    await client().saveDeadline({
      title: "SNAP renewal",
      dueDate,
      kind: "renewal",
      source: { kind: "letter", documentId, sentence: `Your renewal is due by ${dueDate}.` },
      idempotencyKey: `letter-${dueDate}`,
    });
  } finally {
    engine.now = now;
  }
}

// Mail reading a texted photo inside its turn, on recorded pages.
async function mailReads(documentId: string, page: string) {
  return readTextedPhotos(client(), [{ id: documentId, mimeType: "image/jpeg" }], recordedReader([page]), new Date().toISOString(), Date.now() + 60_000);
}

// The sandbox portal's real code (apps/sandbox-portal) on in-memory
// stores, as Engine's sandbox executor reaches it in production.
function realPortal() {
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  const config = { ...DEFAULT_CONFIG, portalToken: PORTAL_TOKEN };
  const posts: { household: Record<string, string>; declaration?: unknown; files: { name: string; type: string; data: string }[] }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(init.body as string));
    return handleRequest(new Request(url, init), store, files, config);
  }) as typeof fetch;
  return { store, posts, executor: new SandboxExecutor("https://portal.test", 1000, fetchFn, PORTAL_TOKEN) };
}

beforeEach(async () => {
  grant = await grantFor(HANDLE);
  engine = new EngineDouble();
  outside = [];
  vi.stubEnv("ENGINE_URL", ENGINE_URL);
  vi.stubEnv("MANO_ENGINE_AGENT_TOKEN", ENGINE_AGENT_TOKEN);
  vi.stubEnv("MANO_PORTAL_URL", "http://portal.test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ENGINE_URL)) return engine.fetch(input, init);
    outside.push(url);
    return new Response("Not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("starting a form draft", () => {
  it("with no proof document on file, asks for a photo and proposes nothing", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    const out = await draft("turn_form000010");
    expect(out.status).toBe("needs_answer");
    expect(out.field).toBe("proof");
    expect(String(out.question)).toMatch(/photo/i);
    expect(out.sent).toBe(false);
    expect(engine.approvals()).toEqual([]);
    expect(portal.posts).toEqual([]);
    expect(outside).toEqual([]);
  });

  it("with her letter on file and no profile, attaches it, holds it for her yes, and the real sandbox portal files it on YES", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES, "2026-12-01", NOV_2);
    const out = await draft("turn_form000011");
    expect(out.status).toBe("waiting_for_yes");
    expect(portal.posts).toEqual([]);
    const [approval] = engine.approvals();
    expect(approval.status).toBe("pending");
    expect(out.approvalId).toBe(approval.id);
    const frozen = JSON.parse(approval.requestJson);
    expect(frozen.payload).toMatchObject(fields);
    expect(frozen.documentId).toBe("doc-letter");
    expect(approval.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(renderQuestion((await client().listApprovals())[0])).toContain("With the photo you sent on November 2, and no proof of income attached.");

    const done = await client().approve(approval.id);
    expect(done.status).toBe("completed");
    expect(done.receipt?.simulated).toBe(false);
    expect(done.receipt?.externalId).toMatch(/\S/);
    expect(portal.posts).toHaveLength(1);
    expect(portal.posts[0].files).toEqual([{ name: "document-1.png", type: "image/png", data: LETTER_PNG }]);
    // The document's description is for the person; the portal gets the form alone.
    expect(Object.keys(portal.posts[0].household).sort()).toEqual(Object.keys(fields).sort());
    expect(outside).toEqual([]);
  });

  it("cites the attached document as the draft's source, so the safety check can see where it came from", async () => {
    photoOnFile("doc-letter", LETTER_BYTES);
    expect((await draft("turn_draft0090")).status).toBe("waiting_for_yes");
    expect(JSON.parse(engine.approvals().at(-1)!.requestJson).sources).toEqual([{ kind: "document", id: "doc-letter" }]);
  });

  it("attaches the newest letter when more than one is on file", async () => {
    await letterOnFile("doc-old", LETTER_BYTES, "2026-11-20", Date.now() - 60_000);
    await letterOnFile("doc-new", LETTER_BYTES, "2026-11-10");
    await draft("turn_form000012");
    expect(frozenDocument()).toBe("doc-new");
  });

  it("attaches the proof fill_form would, the document a profile value was read from, before any letter", async () => {
    photoOnFile("doc-stub", new TextEncoder().encode("%PDF-1.4 synthetic pay stub"), Date.now() - 60_000);
    await letterOnFile("doc-letter", LETTER_BYTES);
    await client().patchProfile({
      idempotencyKey: "profile-stub",
      source: "document",
      documentId: "doc-stub",
      fields: { "income.i1.memberId": "self", "income.i1.source": "job", "income.i1.amount": 900, "income.i1.frequency": "biweekly" },
    });
    await draft("turn_form000013");
    expect(frozenDocument()).toBe("doc-stub");
  });

  // Review of PR 101, blocker 1: Mail can read a letter without saving a
  // deadline (here, one with two dates it will not guess between).
  it("attaches a letter Mail read without saving a deadline, instead of asking for it again", async () => {
    engine.profileKeySet = false;
    photoOnFile("g0t1i0-letter01", new Uint8Array(await letterPhoto()));
    expect((await mailReads("g0t1i0-letter01", DOUBTFUL_PAGE)).read).toBe(true);
    expect(engine.deadlinesOf(PERSON)).toEqual([]);
    const out = await draft("turn_form000020");
    expect(out.status).toBe("waiting_for_yes");
    expect(frozenDocument()).toBe("g0t1i0-letter01");
  });

  // Review of PR 101, should 2: with more than one document on file, the
  // question says which one her YES sends.
  it("names the attached document in the question her YES answers", async () => {
    photoOnFile("g0t1i0-older01", LETTER_BYTES, NOV_2 - 86_400_000);
    photoOnFile("g0t2i0-letter02", new Uint8Array(await letterPhoto()), NOV_2);
    expect((await mailReads("g0t2i0-letter02", RENEWAL_PAGE)).read).toBe(true);
    const out = await draft("turn_form000021");
    expect(out.status).toBe("waiting_for_yes");
    expect(frozenDocument()).toBe("g0t2i0-letter02");
    const question = renderQuestion((await client().listApprovals())[0]);
    expect(question).toContain("With the letter you sent on November 2, and no proof of income attached.");
    expect(question).not.toContain("attachment");
  });

  // Review of PR 101, should 3: Engine keeps one deadline per date and
  // sentence, so a letter sent again keeps its first deadline's time.
  it("attaches a letter sent again last, by when it arrived, though its deadline was saved first", async () => {
    const start = Date.now();
    await letterOnFile("g0t1i0-first-a", LETTER_BYTES, "2026-11-20", start - 120_000);
    await letterOnFile("g0t2i0-other-b", LETTER_BYTES, "2026-12-15", start - 60_000);
    await letterOnFile("g0t3i0-again-a", LETTER_BYTES, "2026-11-20", start);
    expect(engine.deadlinesOf(PERSON)).toHaveLength(2);
    await draft("turn_form000022");
    expect(frozenDocument()).toBe("g0t3i0-again-a");
  });

  it("never attaches a document from a deleted conversation", async () => {
    await letterOnFile("g0t1i0-gone01", LETTER_BYTES);
    await client(1).advanceConversation();
    const out = await draft("turn_form000023", fields, undefined, 1);
    expect(out.status).toBe("needs_answer");
    expect(out.field).toBe("proof");
    expect(engine.approvals()).toEqual([]);
  });

  it("never attaches another person's document", async () => {
    const other = "e".repeat(64);
    photoOnFile("g0t1i0-theirs1", LETTER_BYTES, Date.now(), personIdFor(other));
    await engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!
      .forHandle(other, await grantFor(other), 0)
      .saveDeadline({
        title: "SNAP renewal",
        dueDate: "2026-12-01",
        source: { kind: "letter", documentId: "g0t1i0-theirs1", sentence: "Your renewal is due by 2026-12-01." },
        idempotencyKey: "letter-theirs",
      });
    const out = await draft("turn_form000024");
    expect(out.status).toBe("needs_answer");
    expect(engine.approvals()).toEqual([]);
  });

  it("with only a photo the portal cannot take, asks for one it can instead of the same photo again", async () => {
    engine.profileKeySet = false;
    photoOnFile("g0t1i0-heic001", HEIC_BYTES, NOV_2);
    const first = await draft("turn_form000025");
    expect(first.status).toBe("needs_answer");
    expect(first.field).toBe("proof");
    expect(String(first.question)).toBe(
      "The file you sent on November 2 is a kind of file the renewal portal does not take. Can you send a screenshot of the letter instead?",
    );
    expect(engine.approvals()).toEqual([]);
  });

  // Review of PR 101: the portal takes at most SANDBOX_MAX_UPLOAD_BYTES,
  // so a newer photo too large for it must not block an older one that fits.
  it("with a newer photo too large for the portal and an older PDF that fits, attaches the PDF, and the real portal files it", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    photoOnFile("g0t1i0-stub001", STUB_PDF, NOV_2 - 60_000);
    photoOnFile("g0t2i0-bigpng1", BIG_PNG, NOV_2);
    const out = await draft("turn_form000026");
    expect(out.status).toBe("waiting_for_yes");
    expect(frozenDocument()).toBe("g0t1i0-stub001");
    expect(renderQuestion((await client().listApprovals())[0])).toContain("With the PDF you sent on November 2, and no proof of income attached.");
    // Asked again, it picks the same PDF rather than the photo it cannot file.
    await draft("turn_form000027", fields, Date.now() + 10);
    expect(frozenDocument()).toBe("g0t1i0-stub001");

    const pending = engine.approvals().find((a) => a.status === "pending")!;
    const done = await client().approve(pending.id);
    expect(done.status).toBe("completed");
    expect(done.receipt?.simulated).toBe(false);
    expect(portal.posts).toHaveLength(1);
    expect(portal.posts[0].files.map((f) => f.type)).toEqual(["application/pdf"]);
  });

  it("with only a photo too large for the portal, says so plainly and asks for one that fits", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    photoOnFile("g0t1i0-bigpng2", BIG_PNG, NOV_2);
    const out = await draft("turn_form000028");
    expect(out.status).toBe("needs_answer");
    expect(out.field).toBe("proof");
    expect(String(out.question)).toBe(
      "The photo you sent on November 2 is too large for the renewal portal. Can you send a smaller photo or a screenshot of the letter?",
    );
    expect(engine.approvals()).toEqual([]);
    expect(portal.posts).toEqual([]);
  });

  it("takes the size limit from Engine's config: a lower SANDBOX_MAX_UPLOAD_BYTES changes the answer", async () => {
    engine.profileKeySet = false;
    photoOnFile("g0t1i0-letter03", LETTER_BYTES, NOV_2);
    engine.filer = createExecutor({ EXECUTOR_MODE: "simulated", SANDBOX_MAX_UPLOAD_BYTES: String(LETTER_BYTES.length - 1) });
    const lowered = await draft("turn_form000029");
    expect(lowered.status).toBe("needs_answer");
    expect(String(lowered.question)).toMatch(/too large/);
    expect(engine.approvals()).toEqual([]);

    engine.filer = createExecutor({ EXECUTOR_MODE: "simulated", SANDBOX_MAX_UPLOAD_BYTES: String(LETTER_BYTES.length) });
    const fits = await draft("turn_form000030", fields, Date.now() + 10);
    expect(fits.status).toBe("waiting_for_yes");
    expect(frozenDocument()).toBe("g0t1i0-letter03");
  });

  it("sends nothing outside Mano: Engine freezes the exact draft and waits for the person's yes", async () => {
    await letterOnFile("doc-letter", LETTER_BYTES);
    const out = await draft("turn_form000001");
    expect(outside).toEqual([]);
    expect(engine.executor.calls).toHaveLength(0);
    const approvals = engine.approvals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].actionType).toBe("submit");
    expect(JSON.parse(approvals[0].requestJson).payload).toMatchObject(fields);
    expect(out.approvalId).toBe(approvals[0].id);
  });

  it("a newer draft closes the one before it", async () => {
    await letterOnFile("doc-letter", LETTER_BYTES);
    await draft("turn_form000003");
    await draft("turn_form000004", { ...fields, householdSize: "4" }, Date.now() + 10);
    expect(engine.approvals().map((a) => a.status).sort()).toEqual(["pending", "rejected"]);
  });

  it("refuses when Engine is not configured, and still sends nothing", async () => {
    const c = await ctx("turn_form000002");
    vi.stubEnv("ENGINE_URL", "");
    await expect(startFormDraft.execute({ answers: fields }, c)).rejects.toThrow(/not available/i);
    expect(outside).toEqual([]);
  });
});

// LAP-747. Propel tested general AI agents on SNAP applications in an
// internal test with no real applicants (April 2026): they guessed
// missing fields, cut a mistyped phone number to 10 digits instead of
// asking, and ticked the legal attestation themselves. Mano asks one
// plain question instead of guessing, carries every value exactly as
// given, and leaves the declaration to her YES.
describe("LAP-747: Mano asks instead of guessing", () => {
  const RENEWAL = FORMS["food-renewal"]!;
  const at = "2026-11-02T18:00:00.000Z";
  const leaf = <T>(value: T) => ({ value, source: "person" as const, updatedAt: at });
  const empty = (): Profile => ({ person: { address: {} }, household: [], income: [], programs: [] });

  it("with nothing on file, asks one plain question at a time, most important first, and fills nothing in", () => {
    const answers: Record<string, string> = {};
    const asked: string[] = [];
    for (;;) {
      const filled = fillFrom(RENEWAL, empty(), answers);
      expect(filled.invalid).toEqual([]);
      if (!filled.missing || filled.missing.name === "proof") break;
      asked.push(filled.missing.name);
      // Only what she answered is on the form; nothing else is defaulted.
      expect(Object.keys(filled.values).sort()).toEqual(Object.keys(answers).sort());
      answers[filled.missing.name] = fields[filled.missing.name]!;
    }
    expect(asked).toEqual(["address", "caseNumber", "fullName", "dateOfBirth", "householdSize", "monthlyIncome", "phone"]);
  });

  it("a mistyped phone number on file is asked about, never cut to 10 digits", () => {
    const p = empty();
    p.person.phone = leaf("253-555-01422");
    const typo = fillFrom(RENEWAL, p, Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "phone")));
    expect(typo.values.phone).toBeUndefined();
    expect(typo.missing).toEqual({
      name: "phone",
      label: "Phone number",
      question: "I have 253-555-01422 as your phone number, but it does not fit the form. What phone number should the office use to reach you?",
    });
    // A mistyped answer is asked again, not shortened either.
    const answered = fillFrom(RENEWAL, p, { ...fields, phone: "253-555-01422" });
    expect(answered.invalid.map((i) => i.name)).toEqual(["phone"]);
    expect(answered.values.phone).toBeUndefined();
  });

  it("two different food case numbers on file are asked about, never chosen between", () => {
    const p = empty();
    p.person.address = { line1: leaf("100 Sample St"), city: leaf("Tacoma"), state: leaf("WA"), zip: leaf("98402") };
    p.programs = [
      { id: "snap", program: leaf("SNAP"), state: leaf("WA"), caseNumber: leaf("WA-SNAP-0042117") },
      { id: "calfresh", program: leaf("CalFresh"), state: leaf("WA"), caseNumber: leaf("CF-778812") },
      { id: "medicaid", program: leaf("Medicaid"), state: leaf("WA"), caseNumber: leaf("MC-1") },
    ];
    expect(fillFrom(RENEWAL, p, {}).missing?.name).toBe("caseNumber");
    p.programs.splice(1, 1);
    expect(fillFrom(RENEWAL, p, {}).values.caseNumber).toBe("WA-SNAP-0042117");
  });

  it("a renewal draft with a field missing asks for it and prepares nothing, even with her letter on file", async () => {
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    const { phone: _phone, ...withoutPhone } = fields;
    const out = await draft("turn_ask000001", withoutPhone);
    expect(out).toMatchObject({ status: "needs_answer", field: "phone", question: "What phone number should the office use to reach you?", sent: false });
    expect(engine.approvals()).toEqual([]);
    const typo = await draft("turn_ask000002", { ...fields, phone: "253-555-01422" });
    expect(typo).toMatchObject({ status: "needs_answer", field: "phone" });
    expect(engine.approvals()).toEqual([]);
  });

  it("the question shows the declaration word for word, and only her YES makes it: the filing then carries it as hers", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES, "2026-12-01", NOV_2);
    // Nothing she or the model passes can make the declaration for her.
    const out = await draft("turn_ask000003", { ...fields, declaration: "yes", attestation: "checked" });
    expect(out.status).toBe("waiting_for_yes");
    const [approval] = await client().listApprovals();
    expect(JSON.parse(approval!.requestJson).payload.declaration).toBe(DECLARATION);
    const question = renderQuestion(approval!);
    expect(question).toContain(`It ends with a declaration only you can make: ${DECLARATION} Reply YES to make this declaration yourself and send exactly this, or NO to stop.`);
    expect(presentsExactly(question)).toBe(true);
    expect(portal.posts).toEqual([]);

    const done = await client().approve(approval!.id);
    expect(done.status).toBe("completed");
    expect(portal.posts[0]!.declaration).toEqual({ statement: DECLARATION, madeBy: "applicant" });
    expect((await portal.store.getSubmissionByConfirmation(done.receipt!.externalId))?.declaration).toEqual({ statement: DECLARATION, madeBy: "applicant" });
  });

  it("files her phone number, name, case number and address byte for byte, from her answers and from her letter", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    photoOnFile("doc-letter", LETTER_BYTES, NOV_2);
    // The case number and address as Mail read them off her letter.
    await client().patchProfile({
      idempotencyKey: "letter-facts",
      source: "document",
      documentId: "doc-letter",
      fields: {
        "programs.snap.program": "SNAP",
        "programs.snap.state": "WA",
        "programs.snap.caseNumber": "WA-SNAP 0042117/B",
        "person.address.line1": "12 Calle Ñandú, Apt #3 & 4",
        "person.address.city": "Tacoma",
        "person.address.state": "WA",
        "person.address.zip": "98402",
      },
    });
    // Her name and phone exactly as she texted them.
    const said = { fullName: "María José Núñez-O'Brien", phone: "+1 (253) 555-0142" };
    const { caseNumber: _c, address: _a, ...rest } = fields;
    const out = await draft("turn_ask000004", { ...rest, ...said });
    expect(out.status).toBe("waiting_for_yes");
    const done = await client().approve(String(out.approvalId));
    expect(done.status).toBe("completed");
    const filed = (await portal.store.getSubmissionByConfirmation(done.receipt!.externalId))!.household;
    const bytes = (v: string) => [...new TextEncoder().encode(v)];
    expect(bytes(filed.phone)).toEqual(bytes("+1 (253) 555-0142"));
    expect(bytes(filed.fullName)).toEqual(bytes("María José Núñez-O'Brien"));
    expect(bytes(filed.caseNumber)).toEqual(bytes("WA-SNAP 0042117/B"));
    expect(bytes(filed.address)).toEqual(bytes("12 Calle Ñandú, Apt #3 & 4, Tacoma, WA 98402"));
  });
});

// LAP-747 follow-up, from review of the merged PR.
describe("LAP-747: corrections and spacing", () => {
  it("a correction that does not fit closes the draft shown, so a YES to it files nothing until the new one is answered", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    const shown = await draft("turn_fix000001");
    expect(shown.status).toBe("waiting_for_yes");

    const fix = await draft("turn_fix000002", { ...fields, phone: "253-555-01422" }, Date.now() + 10);
    expect(fix).toMatchObject({ status: "needs_answer", field: "phone" });
    expect((await client().approval(String(shown.approvalId)))?.status).toBe("rejected");
    expect((await client().approve(String(shown.approvalId))).status).not.toBe("completed");
    expect(portal.posts).toEqual([]);

    const fixed = await draft("turn_fix000003", { ...fields, phone: "253-555-0199" }, Date.now() + 20);
    expect(fixed.status).toBe("waiting_for_yes");
    expect((await client().approve(String(fixed.approvalId))).status).toBe("completed");
    expect(portal.posts).toHaveLength(1);
    expect(portal.posts[0]!.household.phone).toBe("253-555-0199");
  });

  it("a correction later in the same turn closes that turn's draft, so the reply carries no question for it", async () => {
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    const at = Date.now();
    expect((await draft("turn_same000001", fields, at)).status).toBe("waiting_for_yes");
    const fix = await draft("turn_same000001", { ...fields, phone: "253-555-01422" }, at);
    expect(fix).toMatchObject({ status: "needs_answer", field: "phone" });
    const approvals = await client().listApprovals();
    expect(approvals.map((a) => a.status)).toEqual(["rejected"]);
    expect(waitingFrom(approvals, 0, "turn_same000001")).toEqual([]);
  });

  // A same-turn correction that throws partway (Engine's document list
  // answers 503) still closes the draft it was correcting, or holds it back
  // when Engine will not close it either.
  it.each([
    { name: "closes", down: /\/documents$/, after: "rejected", held: false },
    { name: "holds back", down: /\/(documents|reject)$/, after: "pending", held: true },
  ])("a correction that throws in the same turn $name the draft it was correcting", async ({ down, after, held }) => {
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    const at = Date.now();
    const turnId = held ? "turn_thr000002" : "turn_thr000001";
    expect((await draft(turnId, fields, at)).status).toBe("waiting_for_yes");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      down.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(draft(turnId, { ...fields, phone: "253-555-0199" }, at)).rejects.toThrow();
    vi.stubGlobal("fetch", engine.fetch);
    const [approval] = await client().listApprovals();
    expect(approval!.status).toBe(after);
    expect(heldBack(turnId, approval!.id)).toBe(held);
  });

  // Review round 1: a correction in a later turn when Engine will not
  // close the version she was shown. She is told it still waits and a YES
  // would send it as it was; her next form call closes it.
  it("a later correction that cannot close the shown draft says so plainly, and the next call closes it", async () => {
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    const shown = await draft("turn_late000001");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      /\/(reject|fence)$/.test(new URL(String(input)).pathname) ? new Response("unavailable", { status: 503 }) : engine.fetch(input, init),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fix = await draft("turn_late000002", { ...fields, phone: "253-555-0199" }, Date.now() + 10);
    vi.stubGlobal("fetch", engine.fetch);
    expect(fix.status).toBe("draft_failed");
    expect(String(fix.note)).toMatch(/still waiting, that a YES would send it as it was, and that they should send their correction again/);
    expect((await client().approval(String(shown.approvalId)))?.status).toBe("pending");

    const again = await draft("turn_late000003", { ...fields, phone: "253-555-0199" }, Date.now() + 20);
    expect(again.status).toBe("waiting_for_yes");
    expect((await client().approval(String(shown.approvalId)))?.status).toBe("rejected");
  });

  // Review round 13: turn A's valid draft is paused at /documents; a newer
  // turn B corrects the phone to one that does not fit and only asks a
  // question. When A resumes, its old phone must not become the latest
  // version a YES would file.
  it("a correction in a newer turn fences the form: an older turn's draft that resumes after it is refused", async () => {
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    let release!: () => void;
    let reached!: () => void;
    const atDocuments = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    let paused = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!paused && new URL(String(input)).pathname.endsWith("/documents") && (init?.method ?? "GET") === "GET") {
        paused = true;
        reached();
        await gate;
      }
      return engine.fetch(input, init);
    });
    const start = Date.now();
    const a = draft("turn_fenceA0001", fields, start);
    await atDocuments;
    const b = await draft("turn_fenceB0001", { ...fields, phone: "253-555-01422" }, start + 10);
    expect(b).toMatchObject({ status: "needs_answer", field: "phone" });
    release();
    const resumed = await a;
    vi.stubGlobal("fetch", engine.fetch);
    expect(resumed.status).not.toBe("waiting_for_yes");
    expect((await client().listApprovals()).filter((x) => x.status === "pending")).toEqual([]);
    expect(engine.executor.calls).toHaveLength(0);
  });

  it("a name typed with two spaces is shown and filed with one, so it can still be put to her YES", async () => {
    const portal = realPortal();
    engine.filer = portal.executor;
    engine.profileKeySet = false;
    await letterOnFile("doc-letter", LETTER_BYTES);
    // A draft is held for her YES only when the text line shows its question word for word.
    const out = await draft("turn_space00001", { ...fields, fullName: "Maria  Santos", phone: "253  555 0100" });
    expect(out.status).toBe("waiting_for_yes");
    const [approval] = await client().listApprovals();
    const question = renderQuestion(approval!);
    expect(question).toContain("Full legal name: Maria Santos;");
    expect(presentsExactly(question)).toBe(true);
    expect((await client().approve(approval!.id)).status).toBe("completed");
    expect(portal.posts[0]!.household.fullName).toBe("Maria Santos");
    expect(portal.posts[0]!.household.phone).toBe("253 555 0100");
  });
});
