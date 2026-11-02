import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  DefiniteFailureError,
  InMemoryExecutor,
  MapDocumentStore,
  MemoryApprovalStore,
  SandboxExecutor,
  TimeoutError,
} from "../src/gateway/index.js";
import { DEFAULT_PORTAL_LIMITS } from "../src/gateway/executors.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";
import { ConsentDeliveringExecutor } from "../src/agents/person-executor.js";
import { sha256Hex } from "../src/hash.js";
import { DEFAULT_CONFIG, handleRequest } from "../../sandbox-portal/src/app";
import { MemoryFileStore, MemoryStore } from "../../sandbox-portal/test/memory-store";

// The sandbox portal's real JSON API (apps/sandbox-portal): POST
// /submissions with a bearer token, { key, household, files }, answers
// { confirmationNumber }; GET /submissions/:key answers it or 404.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));
const HOUSEHOLD = {
  fullName: "Rosa Testcase",
  dateOfBirth: "1984-03-12",
  address: "100 Sample St, Tacoma, WA 98402",
  phone: "253-555-0142",
  householdSize: "3",
  monthlyIncome: "2150",
};

function req(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: { ...HOUSEHOLD },
    idempotencyKey: "agent:g1:turn-1:d0",
    actor: "foreground",
    personId: "person-rosa",
    document: { bytesB64: PNG, hash: "h" },
    ...over,
  };
}

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function portal(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const entry: Seen = {
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
    };
    seen.push(entry);
    return answer(entry);
  }) as typeof fetch;
  return { seen, fetchFn };
}

describe("SandboxExecutor speaks the sandbox portal's JSON API", () => {
  it("files the household and the verified document with the token and returns the confirmation number", async () => {
    const { seen, fetchFn } = portal(() => Response.json({ status: "received", confirmationNumber: "WA-2026-000123", duplicate: false }));
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    const out = await exec.execute(req());
    expect(out).toEqual({ externalId: "WA-2026-000123" });
    expect(seen[0].url).toBe("https://portal.test/submissions");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].auth).toBe("Bearer portal-token");
    expect(seen[0].body?.household).toEqual(HOUSEHOLD);
    expect(seen[0].body?.files).toEqual([{ name: "document-1.png", type: "image/png", data: PNG }]);
    // The downstream key is scoped to the person and fits the portal's 128-character limit.
    const key = seen[0].body?.key as string;
    expect(key).toBe(`mano-${await sha256Hex("person-rosa:agent:g1:turn-1:d0")}`);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("reconciles by the same key: found answers the confirmation number, 404 is absent", async () => {
    const key = `mano-${await sha256Hex("person-rosa:agent:g1:turn-1:d0")}`;
    const { seen, fetchFn } = portal((s) =>
      s.url.endsWith(`/submissions/${key}`)
        ? Response.json({ key, status: "received", confirmationNumber: "WA-2026-000123" })
        : Response.json({ status: "not_found" }, { status: 404 }),
    );
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    expect(await exec.check("agent:g1:turn-1:d0", "person-rosa")).toEqual({ found: true, externalId: "WA-2026-000123" });
    expect(await exec.check("agent:g1:turn-2:d0", "person-rosa")).toEqual({ found: false });
    expect(seen.every((s) => s.auth === "Bearer portal-token")).toBe(true);
  });

  it("treats a 200 lookup without a confirmation number as unavailable, never absent", async () => {
    const { fetchFn } = portal(() => Response.json({ status: "received" }));
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    await expect(exec.check("k", "person-rosa")).rejects.toThrow(/malformed/i);
  });

  it("records a refused filing as a definite failure", async () => {
    const { seen, fetchFn } = portal(() => Response.json({ error: "This office is not taking filings today." }, { status: 400 }));
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token");
    await expect(exec.execute(req())).rejects.toMatchObject({ name: "DefiniteFailureError" });
    expect(seen).toHaveLength(1);
  });

  it("after a timeout, reconciles the filing before any retry and never files twice", async () => {
    let filed: string | null = null;
    let posts = 0;
    const { fetchFn } = portal((s) => {
      if (s.method === "POST") {
        posts += 1;
        filed = s.body?.key as string;
        throw new TimeoutError();
      }
      return filed && s.url.endsWith(`/submissions/${filed}`)
        ? Response.json({ status: "received", confirmationNumber: "WA-2026-000777" })
        : Response.json({ status: "not_found" }, { status: 404 });
    });
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, new SandboxExecutor("https://portal.test", 1000, fetchFn, "portal-token"), {
      policyOverrides: { submit: "allow" },
      documents: new MapDocumentStore(new Map([["letter-png", PNG_BYTES]])),
    });
    // The post timed out after the portal stored it: the gateway asks the
    // portal before calling anything failed, and finds the filing.
    const first = await gw.requestAction(req({ document: undefined, documentId: "letter-png" }));
    expect(first.status).toBe("reconciled");
    expect(first.receipt?.externalId).toBe("WA-2026-000777");
    const again = await gw.requestAction(req({ document: undefined, documentId: "letter-png" }));
    expect(again.receipt?.externalId).toBe("WA-2026-000777");
    expect(posts).toBe(1);
  });
});

// LAP-739 and LAP-730. In sandbox mode the person's yes must only ever be
// asked for a filing the portal will take. These run the gateway against
// the real portal code (apps/sandbox-portal, in-memory stores), so the
// executor's rules and the portal's rules cannot drift apart unnoticed.
const PORTAL_TOKEN = "portal-test-token";
const PDF_BYTES = "%PDF-1.4 synthetic renewal proof";

function realPortal() {
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  const config = { ...DEFAULT_CONFIG, portalToken: PORTAL_TOKEN };
  const posts: Record<string, unknown>[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return handleRequest(new Request(url, init), store, files, config);
  }) as typeof fetch;
  // A raw filing that skips the executor, to ask the portal itself.
  const fileRaw = (body: Record<string, unknown>) =>
    handleRequest(
      new Request("https://portal.test/submissions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${PORTAL_TOKEN}` },
        body: JSON.stringify({ key: `raw-${crypto.randomUUID()}`, ...body }),
      }),
      store,
      files,
      config,
    );
  return { posts, fileRaw, executor: new SandboxExecutor("https://portal.test", 1000, fetchFn, PORTAL_TOKEN) };
}

function sandboxGateway(executor: Executor = realPortal().executor) {
  const store = new MemoryApprovalStore();
  const documents = new MapDocumentStore(
    new Map<string, Uint8Array | string>([
      ["letter-png", PNG_BYTES],
      ["proof-pdf", PDF_BYTES],
      ["notes-txt", "plain text notes, not a document the portal takes"],
    ]),
  );
  return { store, gateway: new ActionGateway(store, executor, { documents }) };
}

function proposal(over: Record<string, unknown> = {}) {
  return {
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: { ...HOUSEHOLD },
    idempotencyKey: `agent:g1:${crypto.randomUUID()}:d0`,
    actor: "foreground",
    personId: "person-rosa",
    ...over,
  };
}

describe("LAP-739: a sandbox submit the portal cannot file is refused before the approval question", () => {
  it("refuses a submit with no document before drafting an approval, and never calls the portal", async () => {
    const portal = realPortal();
    const { store, gateway } = sandboxGateway(portal.executor);
    const result = await gateway.requestAction(proposal());
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/document/i);
    expect(store.approvals.size).toBe(0);
    expect(portal.posts).toHaveLength(0);
  });

  it("holds a submit with a document for the person's yes, and the portal files it after approval", async () => {
    const portal = realPortal();
    const { store, gateway } = sandboxGateway(portal.executor);
    const held = await gateway.requestAction(proposal({ documentId: "letter-png" }));
    expect(held.status).toBe("needs_approval");
    expect(store.approvals.size).toBe(1);
    const done = await gateway.approveAndExecute(held.approval!.id, "person-rosa");
    expect(done.status).toBe("completed");
    expect(done.receipt?.externalId).toMatch(/\S/);
    expect(done.receipt?.simulated).toBe(false);
    expect(portal.posts).toHaveLength(1);
  });

  it.each(["send", "call", "fax"])("refuses a %s at request time: the portal only takes filed applications", async (type) => {
    const portal = realPortal();
    const { store, gateway } = sandboxGateway(portal.executor);
    const result = await gateway.requestAction(proposal({ type, documentId: "letter-png" }));
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/only/i);
    expect(store.approvals.size).toBe(0);
    expect(portal.posts).toHaveLength(0);
  });

  it("still holds a share for approval: shares go to the org agent, not the portal", async () => {
    const executor = new ConsentDeliveringExecutor(
      realPortal().executor,
      async () => ({ externalId: "consent-1" }),
      async () => ({ found: false }),
      () => null,
    );
    const { gateway } = sandboxGateway(executor);
    const result = await gateway.requestAction(proposal({ type: "share", recipient: "org:food-bank" }));
    expect(result.status).toBe("needs_approval");
  });

  it("refuses an approval drafted before this check at execution, as a definite failure with no filing", async () => {
    const portal = realPortal();
    await expect(portal.executor.execute(req({ document: undefined }))).rejects.toBeInstanceOf(DefiniteFailureError);
    await expect(portal.executor.execute(req({ type: "send" }))).rejects.toBeInstanceOf(DefiniteFailureError);
    expect(portal.posts).toHaveLength(0);
  });

  it("leaves simulated mode unchanged: a submit with no document is still held for approval", async () => {
    const { gateway } = sandboxGateway(new InMemoryExecutor());
    const result = await gateway.requestAction(proposal());
    expect(result.status).toBe("needs_approval");
  });
});

describe("LAP-739: the executor and the real portal agree on what can be filed", () => {
  const cases: { name: string; payload: Record<string, unknown>; documentId?: string; portalFiles?: unknown[] }[] = [
    { name: "complete with a PNG", payload: HOUSEHOLD, documentId: "letter-png" },
    { name: "complete with a PDF", payload: HOUSEHOLD, documentId: "proof-pdf" },
    { name: "numbers for size and income", payload: { ...HOUSEHOLD, householdSize: 3, monthlyIncome: 0 }, documentId: "letter-png" },
    { name: "no document", payload: HOUSEHOLD, portalFiles: [] },
    {
      name: "a text document",
      payload: HOUSEHOLD,
      documentId: "notes-txt",
      portalFiles: [{ name: "document-1.txt", type: "text/plain", data: btoa("plain text notes, not a document the portal takes") }],
    },
    { name: "no phone", payload: { ...HOUSEHOLD, phone: undefined }, documentId: "letter-png" },
    { name: "blank name", payload: { ...HOUSEHOLD, fullName: "   " }, documentId: "letter-png" },
    { name: "household size 0", payload: { ...HOUSEHOLD, householdSize: "0" }, documentId: "letter-png" },
    { name: "household size 2.5", payload: { ...HOUSEHOLD, householdSize: "2.5" }, documentId: "letter-png" },
    { name: "negative income", payload: { ...HOUSEHOLD, monthlyIncome: "-1" }, documentId: "letter-png" },
    { name: "an address over 500 characters", payload: { ...HOUSEHOLD, address: "x".repeat(501) }, documentId: "letter-png" },
  ];

  it.each(cases)("$name", async ({ payload, documentId, portalFiles }) => {
    const portal = realPortal();
    const { gateway } = sandboxGateway(portal.executor);
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    const held = await gateway.requestAction(proposal({ payload: clean, ...(documentId ? { documentId } : {}) }));
    if (held.status === "needs_approval") {
      // Admitted: the real portal must file it once the person says yes.
      const done = await gateway.approveAndExecute(held.approval!.id, "person-rosa");
      expect(done.status).toBe("completed");
      return;
    }
    // Refused: the real portal must refuse the same filing too.
    expect(held.status).toBe("blocked");
    const household = Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, String(v)]));
    const files = portalFiles ?? [{ name: "document-1.png", type: "image/png", data: PNG }];
    const raw = await portal.fileRaw({ household, files });
    expect(raw.status).toBe(400);
  });
});

// The document bytes are not part of an idempotency key's content hash,
// so a replay after the document was replaced keeps the same key. Only a
// key with no attempt and no approval may be refused up front; a key with
// history must reconcile or answer its approval, never claim nothing was
// sent while a filing may have reached the portal.
function timingOutPortal() {
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  const config = { ...DEFAULT_CONFIG, portalToken: PORTAL_TOKEN };
  const state = { posts: 0, checkDown: true };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      state.posts += 1;
      await handleRequest(new Request(url, init), store, files, config);
      throw new TimeoutError();
    }
    if (state.checkDown) return new Response("unavailable", { status: 503 });
    return handleRequest(new Request(url, init), store, files, config);
  }) as typeof fetch;
  return { state, executor: new SandboxExecutor("https://portal.test", 1000, fetchFn, PORTAL_TOKEN) };
}

describe("LAP-739: a replay of a key with history is never refused up front", () => {
  it("allow policy: a timed-out filing replayed after the document became plain text reconciles to its receipt", async () => {
    const portal = timingOutPortal();
    const documents = new MapDocumentStore(new Map<string, Uint8Array | string>([["letter", PNG_BYTES]]));
    const gateway = new ActionGateway(new MemoryApprovalStore(), portal.executor, {
      policyOverrides: { submit: "allow" },
      documents,
    });
    const action = proposal({ documentId: "letter" });
    const first = await gateway.requestAction(action);
    expect(first.status).toBe("blocked");
    expect(first.reason).toMatch(/stays unknown/);
    expect(portal.state.posts).toBe(1);

    documents.set("letter", "plain text notes, not a document the portal takes");
    portal.state.checkDown = false;
    const replay = await gateway.requestAction(action);
    expect(replay.reason ?? "").not.toMatch(/Nothing was sent/);
    expect(replay.status).toBe("reconciled");
    expect(replay.receipt?.externalId).toMatch(/\S/);
    expect(portal.state.posts).toBe(1);
  });

  it("ask policy: an approved filing whose outcome is unknown, repeated after the document became plain text", async () => {
    const portal = timingOutPortal();
    const documents = new MapDocumentStore(new Map<string, Uint8Array | string>([["letter", PNG_BYTES]]));
    const store = new MemoryApprovalStore();
    const gateway = new ActionGateway(store, portal.executor, { documents });
    const action = proposal({ documentId: "letter" });
    const held = await gateway.requestAction(action);
    expect(held.status).toBe("needs_approval");
    const approved = await gateway.approveAndExecute(held.approval!.id, "person-rosa");
    expect(approved.status).toBe("blocked");
    expect(approved.reason).toMatch(/stays unknown/);
    expect(portal.state.posts).toBe(1);

    documents.set("letter", "plain text notes, not a document the portal takes");
    const repeat = await gateway.requestAction(action);
    expect(repeat.status).toBe("blocked");
    expect(repeat.reason).not.toMatch(/Nothing was sent/);
    expect(repeat.reason).toBe("This idempotency key was already used with different content.");
    expect(store.approvals.size).toBe(1);
    expect(portal.state.posts).toBe(1);
  });
});

describe("LAP-739: a stale or expired approval is not a way around the check", () => {
  function setup() {
    const portal = realPortal();
    const store = new MemoryApprovalStore();
    const documents = new MapDocumentStore(new Map<string, Uint8Array | string>([["letter", PDF_BYTES]]));
    return { portal, store, documents, gateway: new ActionGateway(store, portal.executor, { documents }) };
  }
  const pending = (store: MemoryApprovalStore) => [...store.approvals.values()].filter((a) => a.status === "pending");

  it("a stale approval repeated after its document became unfileable is refused, not drafted again", async () => {
    const { portal, store, documents, gateway } = setup();
    const action = proposal({ documentId: "letter" });
    const held = await gateway.requestAction(action);
    expect(held.status).toBe("needs_approval");
    documents.set("letter", "plain text notes, not a document the portal takes");
    const answered = await gateway.approveAndExecute(held.approval!.id, "person-rosa");
    expect(answered.status).toBe("stale");
    const repeat = await gateway.requestAction(action);
    expect(repeat.status).toBe("blocked");
    expect(repeat.reason).toMatch(/PDF, PNG or JPG/);
    expect(pending(store)).toHaveLength(0);
    expect(portal.posts).toHaveLength(0);
  });

  it("an expired approval repeated with an unfileable document is refused, not drafted again", async () => {
    const { portal, store, documents, gateway } = setup();
    const action = proposal({ documentId: "letter" });
    const held = await gateway.requestAction(action);
    expect(held.status).toBe("needs_approval");
    store.putApproval({ ...store.getApproval(held.approval!.id)!, status: "expired" });
    documents.set("letter", "plain text notes, not a document the portal takes");
    const repeat = await gateway.requestAction(action);
    expect(repeat.status).toBe("blocked");
    expect(repeat.reason).toMatch(/PDF, PNG or JPG/);
    expect(pending(store)).toHaveLength(0);
    expect(portal.posts).toHaveLength(0);
  });
});

describe("LAP-739: the executor applies the portal's configured limits", () => {
  it("defaults to the portal's own default field and upload limits", () => {
    expect(DEFAULT_PORTAL_LIMITS).toEqual({
      maxFieldLength: DEFAULT_CONFIG.maxFieldLength,
      maxDocumentBytes: DEFAULT_CONFIG.maxUploadBytes,
    });
  });

  it("agrees with a portal configured to other limits", async () => {
    const limits = { maxFieldLength: 600, maxDocumentBytes: 50 };
    const store = new MemoryStore();
    const files = new MemoryFileStore();
    const config = { ...DEFAULT_CONFIG, portalToken: PORTAL_TOKEN, maxFieldLength: 600, maxUploadBytes: 50 };
    const fetchFn = ((url: string, init?: RequestInit) => handleRequest(new Request(url, init), store, files, config)) as typeof fetch;
    const { gateway } = sandboxGateway(new SandboxExecutor("https://portal.test", 1000, fetchFn, PORTAL_TOKEN, limits));

    const longAddress = { ...HOUSEHOLD, address: "x".repeat(550) };
    const held = await gateway.requestAction(proposal({ payload: longAddress, documentId: "proof-pdf" }));
    expect(held.status).toBe("needs_approval");
    expect((await gateway.approveAndExecute(held.approval!.id, "person-rosa")).status).toBe("completed");

    const tooBig = await gateway.requestAction(proposal({ documentId: "letter-png" }));
    expect(PNG_BYTES.length).toBeGreaterThan(50);
    expect(tooBig.status).toBe("blocked");
    expect(tooBig.reason).toMatch(/larger than/);
  });
});
