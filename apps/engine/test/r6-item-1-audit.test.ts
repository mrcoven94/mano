import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 6, item 1 through the real person agent: no part of a
// caller-supplied URL reaches the persisted audit_log, whether it
// arrives as a share recipient (rejected after approval) or as the
// idempotency key (logged before approval).

const SENTINEL_URL = "https://portal.example/renew?case=Sentinel";
const SENTINEL_PARTS = ["https://portal", "portal.example", "/renew", "case=Sentinel", "Sentinel"];

function personStub(name: string) {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name));
}

async function auditRows(stub: DurableObjectStub): Promise<{ event: string; detail: string }[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT event, detail FROM audit_log ORDER BY id").toArray() as unknown as {
      event: string;
      detail: string;
    }[],
  );
}

function expectNoSentinel(rows: { event: string; detail: string }[]) {
  const persisted = rows.map((r) => `${r.event} ${r.detail}`).join("\n");
  for (const part of SENTINEL_PARTS) expect(persisted).not.toContain(part);
}

// The link check resolves through DNS over HTTPS; answer every lookup
// with a public address so the sentinel host counts as allowed.
function allowAllDns() {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ Answer: [{ data: "203.0.113.7" }] }), {
      headers: { "content-type": "application/dns-json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("r6 item 1: audit_log never stores a caller-supplied URL", () => {
  it("a rejected share recipient URL stays out of audit_log after approval", async () => {
    allowAllDns();
    const name = "r6i1-recipient";
    const stub = personStub(name);
    const person = stub as unknown as PersonAgent;
    const share: ActionRequest = {
      type: "share",
      recipient: SENTINEL_URL,
      purpose: "renewal",
      payload: { consent: "grant", caseId: "case-r6i1", scope: ["documents"] },
      idempotencyKey: "r6i1-recipient-key",
      actor: "foreground",
      personId: name,
      sources: [{ kind: "profile", id: name }],
      origin: "person",
    };
    const pending = await person.requestAction(share, name);
    expect(pending.status, pending.reason).toBe("needs_approval");
    const approved = await person.approve(pending.approval!.id, name);
    expect(approved.status).toBe("blocked");

    const rows = await auditRows(stub);
    expect(rows.some((r) => r.event === "gateway.executor_failed")).toBe(true);
    expectNoSentinel(rows);
  });

  it("a URL used as the idempotency key is stored only as a hash", async () => {
    const name = "r6i1-key";
    const stub = personStub(name);
    const person = stub as unknown as PersonAgent;
    const share: ActionRequest = {
      type: "share",
      recipient: "org:r6i1-county",
      purpose: "renewal",
      payload: { consent: "grant", caseId: "case-r6i1-key", scope: ["documents"] },
      idempotencyKey: SENTINEL_URL,
      actor: "foreground",
      personId: name,
      sources: [{ kind: "profile", id: name }],
      origin: "person",
    };
    const pending = await person.requestAction(share, name);
    expect(pending.status, pending.reason).toBe("needs_approval");

    const rows = await auditRows(stub);
    expectNoSentinel(rows);
    const decide = rows.find((r) => r.event === "gateway.decide");
    expect(JSON.parse(decide!.detail).keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
