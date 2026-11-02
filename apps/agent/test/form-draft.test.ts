import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import startFormDraft from "../agent/tools/start_form_draft.js";
import { engineFrom, personIdFor } from "../agent/lib/engine.js";
import { readTextedPhotos } from "../agent/lib/letters.js";
import { renderQuestion } from "../agent/lib/pending.js";
import { SandboxExecutor } from "../../engine/src/gateway/executors.js";
import { DOUBTFUL_PAGE, RENEWAL_PAGE, letterPhoto, recordedReader } from "../../../packages/mail/test/letter-fixture.js";
import { DEFAULT_CONFIG, handleRequest } from "../../sandbox-portal/src/app";
import { MemoryFileStore, MemoryStore } from "../../sandbox-portal/test/memory-store";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "d".repeat(64);
const PERSON = personIdFor(HANDLE);
const fields = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1990-02-03",
  address: "12 Sample Street, Testville",
  phone: "555-0100",
  householdSize: 3,
  monthlyIncome: 1800,
};

// A one-pixel PNG: the photo of her renewal letter Channels stored.
const LETTER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const LETTER_BYTES = Uint8Array.from(atob(LETTER_PNG), (c) => c.charCodeAt(0));
// A phone photo in a format the sandbox portal does not take.
const HEIC_BYTES = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic synthetic photo")]);
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
  return (await startFormDraft.execute(input, await ctx(turnId, turnAtMs, generation))) as Record<string, unknown>;
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
  const posts: { household: Record<string, string>; files: { name: string; type: string; data: string }[] }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(init.body as string));
    return handleRequest(new Request(url, init), store, files, config);
  }) as typeof fetch;
  return { posts, executor: new SandboxExecutor("https://portal.test", 1000, fetchFn, PORTAL_TOKEN) };
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
    expect(renderQuestion((await client().listApprovals())[0])).toContain("With the photo you sent on November 2 attached.");

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
    expect(question).toContain("With the letter you sent on November 2 attached.");
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
    photoOnFile("g0t1i0-heic001", HEIC_BYTES);
    const first = await draft("turn_form000025");
    expect(first.status).toBe("needs_answer");
    expect(first.field).toBe("proof");
    expect(String(first.question)).toMatch(/PDF, PNG or JPG/);
    expect(engine.approvals()).toEqual([]);
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
    await draft("turn_form000004", { ...fields, householdSize: 4 }, Date.now() + 10);
    expect(engine.approvals().map((a) => a.status).sort()).toEqual(["pending", "rejected"]);
  });

  it("refuses when Engine is not configured, and still sends nothing", async () => {
    const c = await ctx("turn_form000002");
    vi.stubEnv("ENGINE_URL", "");
    await expect(startFormDraft.execute(fields, c)).rejects.toThrow(/not available/i);
    expect(outside).toEqual([]);
  });
});
