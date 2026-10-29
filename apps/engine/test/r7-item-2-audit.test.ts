import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonAgent } from "../src/agents/person-agent.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 7, item 2 through real agents: caller-supplied text never lands
// in the persisted audit_log of the person or the org. The sentinel URL
// arrives as an approval ID, as a consent case ID, and as the case ID of
// a raw share request.

const SENTINEL_URL = "https://portal.example/renew?case=Sentinel";
const SENTINEL_PARTS = ["https://portal", "portal.example", "/renew", "case=Sentinel", "Sentinel"];

function stubFor(ns: unknown, name: string) {
  const namespace = ns as DurableObjectNamespace;
  return namespace.get(namespace.idFromName(name));
}

async function auditRows(stub: DurableObjectStub): Promise<string> {
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT event, detail FROM audit_log ORDER BY id").toArray() as unknown as {
      event: string;
      detail: string;
    }[],
  );
  return rows.map((r) => `${r.event} ${r.detail}`).join("\n");
}

function expectNoSentinel(persisted: string) {
  for (const part of SENTINEL_PARTS) expect(persisted).not.toContain(part);
}

// The link check resolves through DNS over HTTPS; answer every lookup
// with a public address so the sentinel host counts as allowed and the
// request reaches approval and delivery.
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

describe("r7 item 2: audit_log never stores caller free text", () => {
  it("an unknown approval ID is not persisted", async () => {
    const name = "r7i2-approval";
    const stub = stubFor(testEnv.PERSON_AGENT, name);
    const person = stub as unknown as PersonAgent;
    const result = await person.approve(encodeURIComponent(SENTINEL_URL), name);
    expect(result.status).toBe("blocked");

    const persisted = await auditRows(stub);
    expectNoSentinel(persisted);
    expectNoSentinel(decodeURIComponent(persisted));
    expect(persisted).toContain("gateway.approve");
  });

  it("a URL as a consent case ID is refused and never persisted", async () => {
    allowAllDns();
    const name = "r7i2-grant";
    const personStub = stubFor(testEnv.PERSON_AGENT, name);
    const orgStub = stubFor(testEnv.ORG_AGENT, "r7i2-county");
    const person = personStub as unknown as PersonAgent;
    const outcome = await person
      .grantConsent(name, { orgAgentId: "org:r7i2-county", purpose: "renewal", scope: ["documents"], caseId: SENTINEL_URL })
      .then(
        (r) => r,
        (err: unknown) => err as Error,
      );
    if (!(outcome instanceof Error) && outcome.approval) await person.approve(outcome.approval.id, name);

    expectNoSentinel(await auditRows(personStub));
    expectNoSentinel(await auditRows(orgStub));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/case ID must be/i);
  });

  it("a raw share whose case ID is a URL fails delivery and is never persisted", async () => {
    allowAllDns();
    const name = "r7i2-raw";
    const personStub = stubFor(testEnv.PERSON_AGENT, name);
    const orgStub = stubFor(testEnv.ORG_AGENT, "r7i2-raw-county");
    const person = personStub as unknown as PersonAgent;
    const share: ActionRequest = {
      type: "share",
      recipient: "org:r7i2-raw-county",
      purpose: "renewal",
      payload: { consent: "grant", caseId: SENTINEL_URL, scope: ["documents"] },
      idempotencyKey: "r7i2-raw-key",
      actor: "foreground",
      personId: name,
      sources: [{ kind: "profile", id: name }],
      origin: "person",
    };
    const pending = await person.requestAction(share, name);
    expect(pending.status, pending.reason).toBe("needs_approval");
    const approved = await person.approve(pending.approval!.id, name);

    expectNoSentinel(await auditRows(personStub));
    expectNoSentinel(await auditRows(orgStub));
    expect(approved.status).toBe("blocked");
  });
});
