import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import startFormDraft from "../agent/tools/start_form_draft.js";
import { engineFrom } from "../agent/lib/engine.js";
import { renderQuestion } from "../agent/lib/pending.js";
import { SandboxExecutor } from "../../engine/src/gateway/executors.js";
import { DEFAULT_CONFIG, handleRequest } from "../../sandbox-portal/src/app";
import { MemoryFileStore, MemoryStore } from "../../sandbox-portal/test/memory-store";
import { toolCtx } from "./ctx.js";
import { ENGINE_AGENT_TOKEN, ENGINE_URL, EngineDouble, grantFor } from "./engine-double.js";

const HANDLE = "d".repeat(64);
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
const PORTAL_TOKEN = "portal-test-token";

let engine: EngineDouble;
let outside: string[];
let grant: string;

const client = () => engineFrom({ baseUrl: ENGINE_URL, agentToken: ENGINE_AGENT_TOKEN, fetchFn: engine.fetch })!.forHandle(HANDLE, grant, 0);

// The turn handler records each turn in Engine's ledger before the model
// runs; a draft names its turn, and Engine orders drafts by it.
async function ctx(turnId: string, turnAtMs = Date.now()) {
  await client().putTurn(turnId, new Date(turnAtMs).toISOString());
  return toolCtx({ handleHash: HANDLE, turnId, grant, turnAtMs });
}

async function draft(turnId: string, input = fields, turnAtMs?: number) {
  return (await startFormDraft.execute(input, await ctx(turnId, turnAtMs))) as Record<string, unknown>;
}

// What Mail does with a texted letter: Channels stores the photo in the
// person's Engine documents, and the deadline read from it names it.
async function letterOnFile(documentId: string, bytes: Uint8Array, dueDate = "2026-12-01") {
  engine.putDocument(HANDLE, documentId, bytes);
  await client().saveDeadline({
    title: "SNAP renewal",
    dueDate,
    kind: "renewal",
    source: { kind: "letter", documentId, sentence: `Your renewal is due by ${dueDate}.` },
    idempotencyKey: `letter-${documentId}`,
  });
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
    await letterOnFile("doc-letter", LETTER_BYTES);
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
    expect(renderQuestion((await client().listApprovals())[0])).toContain("With your document attached.");

    const done = await client().approve(approval.id);
    expect(done.status).toBe("completed");
    expect(done.receipt?.simulated).toBe(false);
    expect(done.receipt?.externalId).toMatch(/\S/);
    expect(portal.posts).toHaveLength(1);
    expect(portal.posts[0].files).toEqual([{ name: "document-1.png", type: "image/png", data: LETTER_PNG }]);
    expect(outside).toEqual([]);
  });

  it("attaches the newest letter when more than one is on file", async () => {
    const start = Date.now();
    engine.now = () => start - 60_000;
    await letterOnFile("doc-old", LETTER_BYTES, "2026-11-20");
    engine.now = () => start;
    await letterOnFile("doc-new", LETTER_BYTES, "2026-11-10");
    await draft("turn_form000012");
    expect(JSON.parse(engine.approvals()[0].requestJson).documentId).toBe("doc-new");
  });

  it("attaches the proof fill_form would, the document a profile value was read from, before any letter", async () => {
    await letterOnFile("doc-letter", LETTER_BYTES);
    engine.putDocument(HANDLE, "doc-stub", new TextEncoder().encode("%PDF-1.4 synthetic pay stub"));
    await client().patchProfile({
      idempotencyKey: "profile-stub",
      source: "document",
      documentId: "doc-stub",
      fields: { "income.i1.memberId": "self", "income.i1.source": "job", "income.i1.amount": 900, "income.i1.frequency": "biweekly" },
    });
    await draft("turn_form000013");
    expect(JSON.parse(engine.approvals()[0].requestJson).documentId).toBe("doc-stub");
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
