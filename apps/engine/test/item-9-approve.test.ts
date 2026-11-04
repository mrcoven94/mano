import { env as testEnv, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";
import { ensureGatewayTables } from "../src/gateway/index.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function personToken(sub: string): Promise<string> {
  return mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
}

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

function actionBody(over: Record<string, unknown> = {}) {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `i9-${crypto.randomUUID()}`,
    actor: "foreground",
    ...over,
  };
}

describe("item 9: approve route and due-approval processing", () => {
  it("approves through the authenticated route and ignores client personId", async () => {
    const token = await personToken("i9maria");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await SELF.fetch("https://mano.test/api/persons/i9maria/action", {
      method: "POST",
      headers,
      body: JSON.stringify(actionBody({ personId: "eve" })),
    });
    expect(created.status).toBe(200);
    const pending = (await created.json()) as { status: string; approval?: { id: string; personId: string } };
    expect(pending.status).toBe("needs_approval");
    expect(pending.approval?.personId).toBe("i9maria");

    const approved = await SELF.fetch(
      `https://mano.test/api/persons/i9maria/approvals/${pending.approval!.id}/approve`,
      { method: "POST", headers, body: "{}" },
    );
    expect(approved.status).toBe(200);
    const done = (await approved.json()) as { status: string; receipt?: { id: string } };
    expect(done.status).toBe("completed");
    expect(done.receipt?.id).toBeTruthy();
  });

  it("rejects unauthenticated and cross-person approvals", async () => {
    const token = await personToken("i9ana");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await SELF.fetch("https://mano.test/api/persons/i9ana/action", {
      method: "POST",
      headers,
      body: JSON.stringify(actionBody()),
    });
    const pending = (await created.json()) as { approval?: { id: string } };
    const path = `https://mano.test/api/persons/i9ana/approvals/${pending.approval!.id}/approve`;

    const noAuth = await SELF.fetch(path, { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(403);
    const eve = await SELF.fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${await personToken("eve")}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(eve.status).toBe(403);
  });

  it("reminds once, escalates near deadlines and expires past-due approvals", async () => {
    const person = personStub("i9due");
    const soon = new Date(Date.now() + 30 * 3600_000).toISOString();
    const made = await person.requestAction(
      { ...actionBody({ deadlineAt: soon }), personId: "i9due" },
      "i9due",
    );
    expect(made.status).toBe("needs_approval");
    const id = made.approval!.id;
    expect(made.approval!.escalated).toBe(false);

    // Twelve hours later the deadline is 18 hours out: remind and escalate.
    const mid = await person.processDueApprovals({ now: new Date(Date.now() + 12 * 3600_000).toISOString() });
    expect(mid.reminded).toContain(id);
    expect(mid.escalated).toContain(id);
    const again = await person.processDueApprovals({ now: new Date(Date.now() + 13 * 3600_000).toISOString() });
    expect(again.reminded).not.toContain(id);

    // Past the 24 hour expiry the approval is done.
    const late = await person.processDueApprovals({ now: new Date(Date.now() + 25 * 3600_000).toISOString() });
    expect(late.expired).toContain(id);
    const approvals = await person.listApprovals("i9due");
    expect(approvals.find((a) => a.id === id)?.status).toBe("expired");
  });

  it("fills deadline_at for approvals stored before the column, and the sweep escalates from it", async () => {
    const person = personStub("i9backfill");
    const soon = new Date(Date.now() + 30 * 3600_000).toISOString();
    const made = await person.requestAction({ ...actionBody({ deadlineAt: soon }), personId: "i9backfill" }, "i9backfill");
    expect(made.status).toBe("needs_approval");
    const id = made.approval!.id;

    const column = await runInDurableObject(person as unknown as DurableObjectStub, (_i, state) => {
      const sql = state.storage.sql;
      expect((sql.exec("SELECT deadline_at FROM approvals WHERE id = ?", id).toArray()[0] as { deadline_at: string }).deadline_at).toBe(soon);
      // A database from before the column: drop it, then migrate again.
      sql.exec("ALTER TABLE approvals DROP COLUMN deadline_at");
      ensureGatewayTables(sql);
      return (sql.exec("SELECT deadline_at FROM approvals WHERE id = ?", id).toArray()[0] as { deadline_at: string | null }).deadline_at;
    });
    expect(column).toBe(soon);

    const mid = await person.processDueApprovals({ now: new Date(Date.now() + 12 * 3600_000).toISOString() });
    expect(mid.escalated).toContain(id);
  });
});
