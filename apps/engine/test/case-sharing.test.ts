import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";
import { mintSessionToken } from "../src/auth.js";
import { applyShareOutcome } from "../src/case-sharing.js";
import type { OrgAgent } from "../src/agents/org-agent.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// LAP-863 through the real Engine routes: two people, two organizations.
// A person shares a case with one organization, staff see only that, staff
// ask for a document and the person answers it, and revoking ends staff
// access at once and for good, for that organization only.

// Must match the bindings in vitest.config.ts.
const SESSION_SECRET = "test-session-secret-not-real";
const PORTAL_TOKEN = "test-portal-token-not-real";
const AGENT_TOKEN = "test-agent-token-not-real";
const GRANT_SECRET = "test-handle-grant-secret-not-real";
const BASE = "https://engine.test";

// A one-pixel PNG standing in for a synthetic pay stub photo.
const PHOTO_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function unique(label: string): string {
  return `${label}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function resident() {
  const handle = crypto.randomUUID().replaceAll("-", "").padEnd(64, "a");
  return { handle, id: personIdForHandle(handle) };
}

type Person = ReturnType<typeof resident>;

async function asPerson(person: Person, method: string, path: string, body?: unknown) {
  const token = await mintSessionToken({ kind: "person", sub: person.id }, SESSION_SECRET);
  return SELF.fetch(`${BASE}/api/persons/${person.id}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function asStaff(org: string, method: string, path: string, body?: unknown, tokenOrg = org) {
  const token = await mintSessionToken({ kind: "staff", sub: `staff-${tokenOrg}`, org: tokenOrg }, SESSION_SECRET);
  return SELF.fetch(`${BASE}/api/orgs/${org}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Proposes a share action and says yes to the exact approval it froze.
async function propose(person: Person, org: string, purpose: string, payload: Record<string, unknown>, documentId?: string) {
  const res = await asPerson(person, "POST", "/action", {
    type: "share",
    recipient: `org:${org}`,
    purpose,
    payload,
    idempotencyKey: `share-${crypto.randomUUID()}`,
    actor: "foreground",
    sources: [{ kind: "profile", id: person.id }],
    origin: "person",
    ...(documentId ? { documentId } : {}),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as { status: string; reason?: string; approval?: { id: string } };
  expect(out.status, out.reason).toBe("needs_approval");
  return out.approval!.id;
}

async function approve(person: Person, approvalId: string) {
  return (await (await asPerson(person, "POST", `/approvals/${approvalId}/approve`)).json()) as { status: string; reason?: string };
}

async function yes(person: Person, org: string, purpose: string, payload: Record<string, unknown>, documentId?: string) {
  const out = await approve(person, await propose(person, org, purpose, payload, documentId));
  expect(out.status, out.reason).toBe("completed");
}

const grant = (person: Person, org: string, caseId: string, details: Record<string, string>) =>
  yes(person, org, "your food benefits renewal", {
    consent: "grant",
    caseId,
    scope: Object.keys(details),
    details: Object.entries(details).map(([label, value]) => ({ label, value })),
  });

const revoke = (person: Person, org: string, caseId: string) =>
  yes(person, org, "stop sharing your food benefits renewal", { consent: "revoke", caseId });

async function caseIds(org: string) {
  const res = await asStaff(org, "GET", "/cases");
  expect(res.status).toBe(200);
  const { cases } = (await res.json()) as { cases: { caseId: string; personId?: string }[] };
  for (const c of cases) expect(c.personId).toBeUndefined();
  return cases.map((c) => c.caseId);
}

interface CaseBody {
  case: {
    details: { label: string; value: string }[];
    requests: { id: string; status: string; label: string }[];
    documents: { id: string; name: string }[];
    requestableKinds: Record<string, string>;
  };
}

async function shares(person: Person) {
  return (await (await asPerson(person, "GET", "/shares")).json()) as {
    active: { recipient: string; caseId: string; openRequests: { id: string; documentKind: string; label: string }[] }[];
    revoked: { recipient: string; caseId: string }[];
  };
}

function askFor(org: string, caseId: string, documentKind = "pay-stub", idempotencyKey = `req-${crypto.randomUUID()}`) {
  return asStaff(org, "POST", `/cases/${caseId}/document-requests`, { documentKind, idempotencyKey });
}

async function upload(person: Person, name = "pay-stub.png") {
  const res = await asPerson(person, "POST", "/documents", { name, contentB64: PHOTO_B64 });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

function agentOf(person: Person) {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(person.id));
}

// Channels as Engine sees it, recording each text by its key.
function recordTexts() {
  const texts: { key: string; text: string }[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { key: string; text: string };
    texts.push({ key: body.key, text: body.text });
    return Response.json({ sent: true });
  });
  return texts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LAP-863: sharing a case with a caseworker", () => {
  it("staff see only what the person shared, with their own organization", async () => {
    const [maria, ana] = [resident(), resident()];
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-maria", { Name: "Maria Testcase", "Case number": "WA-SNAP-0042117" });
    await grant(ana, orgB, "case-ana", { Name: "Ana Testcase" });

    expect(await caseIds(orgA)).toEqual(["case-maria"]);
    expect(await caseIds(orgB)).toEqual(["case-ana"]);

    const view = (await (await asStaff(orgA, "GET", "/cases/case-maria")).json()) as CaseBody;
    expect(view.case.details).toEqual([
      { label: "Name", value: "Maria Testcase" },
      { label: "Case number", value: "WA-SNAP-0042117" },
    ]);
    expect(JSON.stringify(view)).not.toContain(maria.id);
    expect(JSON.stringify(view)).not.toContain("Ana");

    // The other organization's case does not exist here, and another
    // organization's staff token opens nothing.
    recordTexts();
    expect((await asStaff(orgA, "GET", "/cases/case-ana")).status).toBe(404);
    expect((await asStaff(orgB, "GET", "/cases/case-maria")).status).toBe(404);
    expect((await askFor(orgB, "case-maria")).status).toBe(404);
    expect((await asStaff(orgB, "GET", "/cases/case-maria", undefined, orgA)).status).toBe(403);
    // A person's session is not a staff session.
    const personToken = await mintSessionToken({ kind: "person", sub: maria.id }, SESSION_SECRET);
    const asResident = await SELF.fetch(`${BASE}/api/orgs/${orgA}/cases/case-maria`, { headers: { authorization: `Bearer ${personToken}` } });
    expect(asResident.status).toBe(403);
  });

  it("a request reaches the person as one text and her photo reaches only that organization", async () => {
    const [maria, ana] = [resident(), resident()];
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-doc", { Name: "Maria Testcase" });
    await grant(ana, orgB, "case-ana-doc", { Name: "Ana Testcase" });
    const texts = recordTexts();

    const key = `req-${crypto.randomUUID()}`;
    expect((await askFor(orgA, "case-doc", "pay-stub", key)).status).toBe(201);
    // A double click or a retry under the same key changes nothing.
    expect((await askFor(orgA, "case-doc", "pay-stub", key)).status).toBe(201);
    expect((await askFor(orgA, "case-doc", "not-a-kind")).status).toBe(400);

    const agent = agentOf(maria) as unknown as PersonAgent;
    await agent.deliverDueReminders();
    await agent.deliverDueReminders();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe(
      "An office Mano has no name for asked for your pay stub for your food benefits renewal. Send a photo of it here and I will check with you before it goes to them.",
    );
    expect(await agent.listReminders(maria.id)).toEqual([]);

    const open = (await shares(maria)).active[0]!.openRequests;
    expect(open).toMatchObject([{ id: key, documentKind: "pay-stub", label: "pay stub" }]);
    expect((await shares(ana)).active[0]!.openRequests).toEqual([]);

    const documentId = await upload(maria);
    await yes(maria, orgA, "send your pay stub for your food benefits renewal", { consent: "provide", caseId: "case-doc", requestId: key, documentKind: "pay-stub" }, documentId);

    const view = (await (await asStaff(orgA, "GET", "/cases/case-doc")).json()) as CaseBody;
    expect(view.case.documents).toMatchObject([{ id: documentId, name: "pay-stub.png" }]);
    expect(view.case.requests).toMatchObject([{ id: key, status: "provided" }]);
    expect((await shares(maria)).active[0]!.openRequests).toEqual([]);

    const file = await asStaff(orgA, "GET", `/cases/case-doc/documents/${documentId}`);
    expect(file.status).toBe(200);
    expect(btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))).toBe(PHOTO_B64);

    expect((await asStaff(orgB, "GET", `/cases/case-doc/documents/${documentId}`)).status).toBe(404);
    expect((await asStaff(orgB, "GET", `/cases/case-ana-doc/documents/${documentId}`)).status).toBe(404);
    // A document Maria never sent stays hers, on a case she did share.
    const other = await upload(maria, "private.png");
    expect((await asStaff(orgA, "GET", `/cases/case-doc/documents/${other}`)).status).toBe(404);
  });

  it("a redelivered document changes nothing, and reconcile finds it by its own event type", async () => {
    const maria = resident();
    const org = unique("county");
    await grant(maria, org, "case-redeliver", { Name: "Maria Testcase" });
    recordTexts();
    const key = `req-${crypto.randomUUID()}`;
    expect((await askFor(org, "case-redeliver", "pay-stub", key)).status).toBe(201);
    const documentId = await upload(maria);
    await yes(maria, org, "send your pay stub", { consent: "provide", caseId: "case-redeliver", requestId: key, documentKind: "pay-stub" }, documentId);

    const sent = await runInDurableObject(agentOf(maria), (_i, state) =>
      (state.storage.sql.exec("SELECT idempotency_key, message_json FROM outbound_consent WHERE message_json LIKE '%document.provide%'").toArray() as { idempotency_key: string; message_json: string }[])[0]!,
    );
    const ns = testEnv.ORG_AGENT as DurableObjectNamespace;
    const stub = ns.get(ns.idFromName(org)) as unknown as OrgAgent;
    expect(await stub.receiveDocument(JSON.parse(sent.message_json))).toEqual({ accepted: true, duplicate: true });
    expect(await stub.hasConsentRecord(`person:${maria.id}`, sent.idempotency_key, "document")).toBe(true);
    expect(await stub.hasConsentRecord(`person:${maria.id}`, sent.idempotency_key, "share")).toBe(false);
    const view = (await (await asStaff(org, "GET", "/cases/case-redeliver")).json()) as CaseBody;
    expect(view.case.documents).toHaveLength(1);
  });

  it("a document goes only in answer to a request on a case still shared", async () => {
    const maria = resident();
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-unasked", { Name: "Maria Testcase" });
    const documentId = await upload(maria);
    // Nothing was asked for, and nothing is shared with the other org.
    const unasked = await approve(maria, await propose(maria, orgA, "send a pay stub", { consent: "provide", caseId: "case-unasked", requestId: "req-not-a-request", documentKind: "pay-stub" }, documentId));
    expect(unasked.status).not.toBe("completed");
    const elsewhere = await approve(maria, await propose(maria, orgB, "send a pay stub", { consent: "provide", caseId: "case-unasked", requestId: "req-not-a-request", documentKind: "pay-stub" }, documentId));
    expect(elsewhere.status).not.toBe("completed");
    const view = (await (await asStaff(orgA, "GET", "/cases/case-unasked")).json()) as CaseBody;
    expect(view.case.documents).toEqual([]);
  });

  it("revoking ends staff access at once and every later request fails closed", async () => {
    const maria = resident();
    const org = unique("county");
    await grant(maria, org, "case-revoke", { Name: "Maria Testcase" });
    const texts = recordTexts();
    const first = `req-${crypto.randomUUID()}`;
    expect((await askFor(org, "case-revoke", "pay-stub", first)).status).toBe(201);
    const documentId = await upload(maria);
    await yes(maria, org, "send your pay stub", { consent: "provide", caseId: "case-revoke", requestId: first, documentKind: "pay-stub" }, documentId);
    expect((await asStaff(org, "GET", `/cases/case-revoke/documents/${documentId}`)).status).toBe(200);

    // A second request waits unanswered, and a draft answering it waits for
    // her yes when she revokes. A third has its text still scheduled.
    const second = `req-${crypto.randomUUID()}`;
    expect((await askFor(org, "case-revoke", "bank-statement", second)).status).toBe(201);
    await runInDurableObject(agentOf(maria), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO document_requests VALUES (?, 'req-unsent', 'case-revoke', 'photo-id', 'open', ?)", `org:${org}`, new Date().toISOString());
      sql.exec(
        "INSERT INTO reminders(id, text, due_at_ms, generation, status, next_at_ms, created_at_ms) VALUES (?, 'unsent', ?, 0, 'scheduled', ?, ?)",
        `case-request:org:${org}:req-unsent`, Date.now() + 3_600_000, Date.now() + 3_600_000, Date.now(),
      );
    });
    const lateDraft = await propose(maria, org, "send your bank statement", { consent: "provide", caseId: "case-revoke", requestId: second, documentKind: "bank-statement" }, documentId);
    await revoke(maria, org, "case-revoke");

    expect(await caseIds(org)).toEqual([]);
    expect((await asStaff(org, "GET", "/cases/case-revoke")).status).toBe(404);
    expect((await asStaff(org, "GET", `/cases/case-revoke/documents/${documentId}`)).status).toBe(404);
    expect((await askFor(org, "case-revoke")).status).toBe(404);
    expect(await shares(maria)).toMatchObject({ active: [], revoked: [{ recipient: `org:${org}`, caseId: "case-revoke" }] });

    expect((await approve(maria, lateDraft)).status).not.toBe("completed");
    const after = await runInDurableObject(agentOf(maria), (_i, state) => ({
      requests: state.storage.sql.exec("SELECT status FROM document_requests WHERE id IN (?, 'req-unsent')", second).toArray(),
      text: state.storage.sql.exec("SELECT status FROM reminders WHERE id = ?", `case-request:org:${org}:req-unsent`).toArray(),
    }));
    expect(after).toEqual({ requests: [{ status: "closed" }, { status: "closed" }], text: [{ status: "cancelled" }] });
    expect(texts.some((t) => t.key.includes("req-unsent"))).toBe(false);
  });

  it("a request after the share ended never reaches the person", async () => {
    const maria = resident();
    const org = unique("county");
    await grant(maria, org, "case-after", { Name: "Maria Testcase" });
    await revoke(maria, org, "case-after");
    const texts = recordTexts();
    expect((await askFor(org, "case-after")).status).toBe(404);
    await (agentOf(maria) as unknown as PersonAgent).deliverDueReminders();
    expect(texts).toEqual([]);
    expect((await shares(maria)).active).toEqual([]);
  });

  it("a revoke for one organization leaves another's grant for the same case alone", async () => {
    const maria = resident();
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-both", { Name: "Maria Testcase" });
    await grant(maria, orgB, "case-both", { Name: "Maria T" });

    await revoke(maria, orgA, "case-both");
    recordTexts();
    expect(await caseIds(orgA)).toEqual([]);
    expect(await caseIds(orgB)).toEqual(["case-both"]);
    expect((await askFor(orgB, "case-both")).status).toBe(201);
    expect((await askFor(orgA, "case-both")).status).toBe(404);
  });

  it("a grant to a new organization works after a revoke, and the revoked one stays revoked", async () => {
    const maria = resident();
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-new-org", { Name: "Maria Testcase" });
    await revoke(maria, orgA, "case-new-org");

    await grant(maria, orgB, "case-new-org", { Name: "Maria Testcase" });
    expect(await caseIds(orgB)).toEqual(["case-new-org"]);

    // The same organization and case: refused for good, and no access.
    const refused = await approve(maria, await propose(maria, orgA, "your food benefits renewal", { consent: "grant", caseId: "case-new-org", scope: [] }));
    expect(refused.status).not.toBe("completed");
    expect(await caseIds(orgA)).toEqual([]);
    const person = agentOf(maria) as unknown as PersonAgent;
    const again = await person.grantConsent(maria.id, { orgAgentId: `org:${orgA}`, purpose: "renewal", scope: [], caseId: "case-new-org" });
    expect(again).toMatchObject({ status: "blocked" });

    // Sharing again opens a new case, which shows nothing of the old one.
    await grant(maria, orgA, "case-new-org-r1", { Name: "Maria Testcase" });
    expect(await caseIds(orgA)).toEqual(["case-new-org-r1"]);
    expect((await asStaff(orgA, "GET", "/cases/case-new-org")).status).toBe(404);
  });

  it("revocations recorded per case move to the organization their message named", async () => {
    const maria = resident();
    const org = unique("county");
    await grant(maria, org, "case-legacy", { Name: "Maria Testcase" });
    await revoke(maria, org, "case-legacy");
    const rows = await runInDurableObject(agentOf(maria), async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM revoked_shares");
      sql.exec("CREATE TABLE revoked_cases(case_id TEXT PRIMARY KEY, revoked_at TEXT NOT NULL)");
      sql.exec("INSERT INTO revoked_cases VALUES ('case-legacy', '2026-11-03T00:00:00.000Z')");
      const { migrateRevokedCases } = await import("../src/case-sharing.js");
      migrateRevokedCases(sql as never);
      return {
        shares: sql.exec("SELECT recipient, case_id, revoked_at FROM revoked_shares").toArray(),
        old: sql.exec("SELECT name FROM sqlite_master WHERE name = 'revoked_cases'").toArray(),
      };
    });
    expect(rows.shares).toEqual([{ recipient: `org:${org}`, case_id: "case-legacy", revoked_at: "2026-11-03T00:00:00.000Z" }]);
    expect(rows.old).toEqual([]);
  });

  it("the agent reads shares with the turn's handle grant, for that person only", async () => {
    const [maria, ana] = [resident(), resident()];
    const grantHeader = await mintHandleGrant(maria.handle, GRANT_SECRET);
    const read = (person: Person) =>
      SELF.fetch(`${BASE}/api/persons/${person.id}/shares`, { headers: { authorization: `Bearer ${AGENT_TOKEN}`, "x-mano-handle-grant": grantHeader } });
    expect((await read(maria)).status).toBe(200);
    expect((await read(ana)).status).toBe(403);
  });
});

describe("LAP-863: a document grant is one approved document, in one conversation", () => {
  const OTHER_PHOTO_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAAEhgGAWe7PkAAAAABJRU5ErkJggg==";

  function deleteConversation(person: Person, generation: number) {
    return (async () =>
      SELF.fetch(`${BASE}/api/persons/${person.id}/conversation`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${AGENT_TOKEN}`,
          "x-mano-handle-grant": await mintHandleGrant(person.handle, GRANT_SECRET),
          "content-type": "application/json",
        },
        body: JSON.stringify({ generation }),
      }))();
  }

  // Maria shares document D in answer to a request, with her yes.
  async function sharedDocument(label: string) {
    const maria = resident();
    const org = unique(label);
    const caseId = `case-${label}`;
    recordTexts();
    await grant(maria, org, caseId, { Name: "Maria Testcase" });
    const key = `req-${crypto.randomUUID()}`;
    expect((await askFor(org, caseId, "pay-stub", key)).status).toBe(201);
    const id = `doc-${crypto.randomUUID()}`;
    const stored = await asPerson(maria, "POST", "/documents", { name: "pay-stub.png", contentB64: PHOTO_B64, id });
    expect(stored.status).toBe(200);
    await yes(maria, org, "send your pay stub", { consent: "provide", caseId, requestId: key, documentKind: "pay-stub" }, id);
    expect((await asStaff(org, "GET", `/cases/${caseId}/documents/${id}`)).status).toBe(200);
    return { maria, org, caseId, id };
  }

  it("the old staff URL opens nothing after a delete, even with new bytes under the same ID", async () => {
    const { maria, org, caseId, id } = await sharedDocument("reused");
    expect((await deleteConversation(maria, 1)).status).toBe(200);
    expect((await asStaff(org, "GET", `/cases/${caseId}/documents/${id}`)).status).toBe(404);

    const again = await asPerson(maria, "POST", "/documents", { name: "medical-letter.png", contentB64: OTHER_PHOTO_B64, id });
    expect(again.status).toBe(200);
    const res = await asStaff(org, "GET", `/cases/${caseId}/documents/${id}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("medical-letter");
  });

  it("the same bytes under the same ID after a delete still need a new yes", async () => {
    const { maria, org, caseId, id } = await sharedDocument("samebytes");
    expect((await deleteConversation(maria, 1)).status).toBe(200);
    expect((await asPerson(maria, "POST", "/documents", { name: "pay-stub.png", contentB64: PHOTO_B64, id })).status).toBe(200);
    expect((await asStaff(org, "GET", `/cases/${caseId}/documents/${id}`)).status).toBe(404);
  });

  it("a stored document that no longer matches the approved hash opens nothing", async () => {
    const { maria, org, caseId, id } = await sharedDocument("hash");
    await runInDurableObject(agentOf(maria), (_i, state) => {
      state.storage.sql.exec("UPDATE documents SET hash = ? WHERE id = ?", "0".repeat(64), id);
    });
    expect((await asStaff(org, "GET", `/cases/${caseId}/documents/${id}`)).status).toBe(404);
  });

  it("a grant is never written for a document the delete already removed", async () => {
    const { maria, org, caseId, id } = await sharedDocument("racing");
    const rows = await runInDurableObject(agentOf(maria), (_i, state) => {
      const sql = state.storage.sql;
      const hash = (sql.exec("SELECT hash FROM documents WHERE id = ?", id).toArray()[0] as { hash: string }).hash;
      sql.exec("DELETE FROM shared_documents");
      sql.exec("DELETE FROM documents WHERE id = ?", id);
      applyShareOutcome(
        sql as never,
        {
          recipient: `org:${org}`,
          purpose: "send your pay stub",
          documentHash: hash,
          documentId: id,
          requestJson: JSON.stringify({ payload: { consent: "provide", caseId, requestId: "r" }, documentId: id }),
        },
        Date.now(),
      );
      return sql.exec("SELECT * FROM shared_documents").toArray();
    });
    expect(rows).toEqual([]);
  });

  it("after a delete staff see only the approved values, and the person hears it once on their next text", async () => {
    const { maria, org, caseId } = await sharedDocument("keeps");
    const open = `req-${crypto.randomUUID()}`;
    expect((await askFor(org, caseId, "bank-statement", open)).status).toBe(201);
    expect((await deleteConversation(maria, 1)).status).toBe(200);

    const view = (await (await asStaff(org, "GET", `/cases/${caseId}`)).json()) as CaseBody;
    expect(view.case.details).toEqual([{ label: "Name", value: "Maria Testcase" }]);
    expect(view.case.documents).toEqual([]);
    expect((await shares(maria)).active[0]!.openRequests).toEqual([]);

    const turns = async (turnId: string) => {
      const headers = {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "x-mano-handle-grant": await mintHandleGrant(maria.handle, GRANT_SECRET),
        "content-type": "application/json",
      };
      const put = await SELF.fetch(`${BASE}/api/persons/${maria.id}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ turnId, receivedAt: new Date().toISOString(), generation: 1 }),
      });
      return { body: (await put.json()) as { shareNotice?: string }, headers };
    };
    const first = await turns("turn_notice_0001");
    expect(first.body.shareNotice).toContain("can no longer open the documents you sent");
    expect(first.body.shareNotice).toContain("still has the details you approved for your food benefits renewal");
    expect(first.body.shareNotice).toContain("cannot recall");

    // A retry before the reply went out still carries it.
    expect((await turns("turn_notice_0001")).body.shareNotice).toBeDefined();
    const done = await SELF.fetch(`${BASE}/api/persons/${maria.id}/turns/turn_notice_0001/complete`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ generation: 1, shareNoticeShown: true }),
    });
    expect(done.status).toBe(200);
    expect((await turns("turn_notice_0002")).body.shareNotice).toBeUndefined();
  });

  it("a delete with nothing shared promises nothing", async () => {
    const maria = resident();
    expect((await deleteConversation(maria, 1)).status).toBe(200);
    const put = await SELF.fetch(`${BASE}/api/persons/${maria.id}/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "x-mano-handle-grant": await mintHandleGrant(maria.handle, GRANT_SECRET),
        "content-type": "application/json",
      },
      body: JSON.stringify({ turnId: "turn_notice_none", receivedAt: new Date().toISOString(), generation: 1 }),
    });
    expect(((await put.json()) as { shareNotice?: string }).shareNotice).toBeUndefined();
  });
});

describe("LAP-863: a request's text belongs to one organization and one open request", () => {
  async function reminderStatuses(person: Person) {
    return runInDurableObject(agentOf(person), (_i, state) =>
      (state.storage.sql.exec("SELECT id, status FROM reminders WHERE id LIKE 'case-request:%' ORDER BY id").toArray() as { id: string; status: string }[]),
    );
  }

  function channelsDown() {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
  }

  async function makeDue(person: Person) {
    await runInDurableObject(agentOf(person), (_i, state) => {
      state.storage.sql.exec("UPDATE reminders SET next_at_ms = 0, claim_token = NULL, claimed_at_ms = NULL WHERE id LIKE 'case-request:%' AND status = 'sending'");
    });
  }

  it("two organizations using one key each reach the person", async () => {
    const maria = resident();
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-key-a", { Name: "Maria Testcase" });
    await grant(maria, orgB, "case-key-b", { Name: "Maria Testcase" });
    const texts = recordTexts();
    const key = `req-${crypto.randomUUID()}`;
    expect((await askFor(orgA, "case-key-a", "pay-stub", key)).status).toBe(201);
    expect((await askFor(orgB, "case-key-b", "photo-id", key)).status).toBe(201);
    await (agentOf(maria) as unknown as PersonAgent).deliverDueReminders();
    expect(new Set(texts.map((t) => t.key)).size).toBe(2);
    expect(texts.map((t) => t.text).join(" ")).toContain("pay stub");
    expect(texts.map((t) => t.text).join(" ")).toContain("photo ID");
  });

  it("revoking one organization leaves the other's text with the same key", async () => {
    const maria = resident();
    const [orgA, orgB] = [unique("county"), unique("nonprofit")];
    await grant(maria, orgA, "case-keep-a", { Name: "Maria Testcase" });
    await grant(maria, orgB, "case-keep-b", { Name: "Maria Testcase" });
    channelsDown();
    const key = `req-${crypto.randomUUID()}`;
    expect((await askFor(orgA, "case-keep-a", "pay-stub", key)).status).toBe(201);
    expect((await askFor(orgB, "case-keep-b", "photo-id", key)).status).toBe(201);
    const agent = agentOf(maria) as unknown as PersonAgent;
    await agent.deliverDueReminders();
    await revoke(maria, orgA, "case-keep-a");

    const texts = recordTexts();
    await makeDue(maria);
    await agent.deliverDueReminders();
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain("photo ID");
  });

  it("a text waiting on a retry is withdrawn when the person stops sharing", async () => {
    const maria = resident();
    const org = unique("county");
    await grant(maria, org, "case-retry", { Name: "Maria Testcase" });
    channelsDown();
    expect((await askFor(org, "case-retry")).status).toBe(201);
    const agent = agentOf(maria) as unknown as PersonAgent;
    await agent.deliverDueReminders();
    expect((await reminderStatuses(maria)).map((r) => r.status)).toEqual(["sending"]);

    await revoke(maria, org, "case-retry");
    expect((await reminderStatuses(maria)).map((r) => r.status)).toEqual(["withdrawn"]);

    const texts = recordTexts();
    await makeDue(maria);
    await agent.deliverDueReminders();
    expect(texts).toEqual([]);
  });

  it("a text waiting on a retry is withdrawn when the person already answered", async () => {
    const maria = resident();
    const org = unique("county");
    await grant(maria, org, "case-answered", { Name: "Maria Testcase" });
    channelsDown();
    const key = `req-${crypto.randomUUID()}`;
    expect((await askFor(org, "case-answered", "pay-stub", key)).status).toBe(201);
    const agent = agentOf(maria) as unknown as PersonAgent;
    await agent.deliverDueReminders();
    const documentId = await upload(maria);
    await yes(maria, org, "send your pay stub", { consent: "provide", caseId: "case-answered", requestId: key, documentKind: "pay-stub" }, documentId);
    expect((await reminderStatuses(maria)).map((r) => r.status)).toEqual(["withdrawn"]);
  });
});

describe("LAP-863: the staff session", () => {
  const signIn = (token: string, orgId: string) =>
    SELF.fetch(`${BASE}/api/staff/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ orgId }),
    });

  it("opens the sandbox org's routes and only those", async () => {
    const res = await signIn(PORTAL_TOKEN, "sandbox-county");
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const open = (org: string) => SELF.fetch(`${BASE}/api/orgs/${org}/cases`, { headers: { authorization: `Bearer ${token}` } });
    expect((await open("sandbox-county")).status).toBe(200);
    expect((await open("some-other-org")).status).toBe(403);
  });

  it("refuses any other org and any other token", async () => {
    expect((await signIn(PORTAL_TOKEN, "some-other-org")).status).toBe(403);
    expect((await signIn("not-the-token", "sandbox-county")).status).toBe(403);
    expect((await signIn(AGENT_TOKEN, "sandbox-county")).status).toBe(403);
  });
});
