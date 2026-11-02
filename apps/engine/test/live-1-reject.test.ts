import { SELF, env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken } from "../src/auth.js";

// A NO ends a pending approval at once: the approval is rejected, a later
// approve cannot run it, a second NO answers the same, and audit_log
// records the rejection with hashes only.

// Must match the SESSION_SECRET binding in vitest.config.ts.
const TEST_SESSION_SECRET = "test-session-secret-not-real";

async function call(personId: string, path: string, init: RequestInit = {}, sub = personId) {
  const token = await mintSessionToken({ kind: "person", sub }, TEST_SESSION_SECRET);
  return SELF.fetch(`https://engine.test/api/persons/${personId}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

async function pendingApproval(personId: string): Promise<string> {
  const res = await call(personId, "/action", {
    method: "POST",
    body: JSON.stringify({
      type: "submit",
      recipient: "sandbox-agency",
      purpose: "renewal",
      payload: {},
      idempotencyKey: `live1-${crypto.randomUUID()}`,
      actor: "foreground",
      sources: [],
      origin: "person",
    }),
  });
  const out = (await res.json()) as { status: string; approval?: { id: string } };
  expect(out.status).toBe("needs_approval");
  return out.approval!.id;
}

describe("POST /api/persons/:id/approvals/:approvalId/reject", () => {
  it("rejects a pending approval, idempotently, and approve can no longer run it", async () => {
    const personId = "live1-maria";
    const approvalId = await pendingApproval(personId);

    const first = await call(personId, `/approvals/${approvalId}/reject`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe("rejected");

    const second = await call(personId, `/approvals/${approvalId}/reject`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("rejected");

    const approve = await call(personId, `/approvals/${approvalId}/approve`, { method: "POST" });
    const approved = (await approve.json()) as { status: string; reason?: string };
    expect(approved.status).toBe("blocked");
    expect(approved.reason).toMatch(/declined/i);

    const list = (await (await call(personId, "/approvals")).json()) as { approvals: { id: string; status: string }[] };
    expect(list.approvals.find((a) => a.id === approvalId)?.status).toBe("rejected");

    const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
    const rows = await runInDurableObject(ns.get(ns.idFromName(personId)), (_i, state) =>
      state.storage.sql.exec("SELECT event, detail FROM audit_log WHERE event = 'gateway.reject'").toArray() as unknown as {
        detail: string;
      }[],
    );
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.detail).not.toContain(approvalId);
      expect(JSON.parse(row.detail).approvalHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("does not reject an approval that already ran or does not exist", async () => {
    const personId = "live1-ran";
    const approvalId = await pendingApproval(personId);
    const approve = await call(personId, `/approvals/${approvalId}/approve`, { method: "POST" });
    expect(((await approve.json()) as { status: string }).status).toBe("completed");
    const late = (await (await call(personId, `/approvals/${approvalId}/reject`, { method: "POST" })).json()) as {
      status: string;
    };
    expect(late.status).toBe("blocked");
    const missing = (await (await call(personId, `/approvals/${crypto.randomUUID()}/reject`, { method: "POST" })).json()) as {
      status: string;
      reason?: string;
    };
    expect(missing.status).toBe("blocked");
    expect(missing.reason).toMatch(/not found/i);
  });

  it("refuses another person's token", async () => {
    const approvalId = await pendingApproval("live1-owner");
    const res = await call("live1-owner", `/approvals/${approvalId}/reject`, { method: "POST" }, "live1-intruder");
    expect(res.status).toBe(403);
  });
});
