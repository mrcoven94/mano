import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  DefiniteFailureError,
  InMemoryExecutor,
  MapDocumentStore,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest, Executor } from "../src/gateway/index.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Confirming tests for items implemented with the gateway rework:
// scoped idempotency keys (7), documents into execution (8), every URL
// checked (12), per-action simulated labels (13) and definite failures (18).

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `r2i-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

function personStub(name: string): PersonAgent {
  const ns = testEnv.PERSON_AGENT as DurableObjectNamespace;
  return ns.get(ns.idFromName(name)) as unknown as PersonAgent;
}

describe("r2 items 7, 8, 12, 13, 18: gateway rework confirmations", () => {
  it("item 7: rejects reuse of a key with different content", async () => {
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      policyOverrides: { submit: "allow" },
    });
    const first = await gw.requestAction(baseReq({ idempotencyKey: "r2i7-key", payload: { v: 1 } }));
    expect(first.status).toBe("completed");
    const reuse = await gw.requestAction(baseReq({ idempotencyKey: "r2i7-key", payload: { v: 2 } }));
    expect(reuse.status).toBe("blocked");
    expect(reuse.reason).toMatch(/different content/);
    const replay = await gw.requestAction(baseReq({ idempotencyKey: "r2i7-key", payload: { v: 1 } }));
    expect(replay.status).toBe("completed");
  });

  it("item 8: posts the verified document bytes and hash to the portal", async () => {
    const posted: Record<string, unknown>[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      posted.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify({ confirmationNumber: "portal-doc" }), { status: 200 });
    }) as typeof fetch;
    const { SandboxExecutor } = await import("../src/gateway/index.js");
    const exec = new SandboxExecutor("https://portal.test", 1000, fetchFn);
    const gw = new ActionGateway(new MemoryApprovalStore(), exec, {
      policyOverrides: { submit: "allow" },
      documents: new MapDocumentStore(new Map([["doc-8", "%PDF-1.4 exact bytes v1"]])),
    });
    const result = await gw.requestAction(baseReq({ idempotencyKey: "r2i8-key", documentId: "doc-8" }));
    expect(result.status).toBe("completed");
    const files = posted[0].files as { name: string; type: string; data: string }[];
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("application/pdf");
    expect(atob(files[0].data)).toBe("%PDF-1.4 exact bytes v1");
  });

  it("item 12: checks URLs nested anywhere in the payload", async () => {
    const seen: string[] = [];
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      linkCheck: async (url) => {
        seen.push(url);
        return url.includes("evil.example") ? { allowed: false, reason: "Blocked domain." } : { allowed: true };
      },
    });
    const blocked = await gw.requestAction(
      baseReq({
        payload: {
          text: "see https://evil.example.com/phish for details",
          attachments: [{ href: "https://files.example.com/a.pdf" }],
        },
      }),
    );
    expect(blocked.status).toBe("blocked");
    expect(seen).toContain("https://evil.example.com/phish");

    seen.length = 0;
    const nested = await gw.requestAction(
      baseReq({ payload: { attachments: [{ href: "https://evil.example.com/nested" }] } }),
    );
    expect(nested.status).toBe("blocked");
    expect(seen).toContain("https://evil.example.com/nested");

    const clean = await gw.requestAction(baseReq({ payload: { note: "no links here" } }));
    expect(clean.status).toBe("needs_approval");
  });

  it("item 13: labels a delivered share as real with a simulated inner executor", async () => {
    const person = personStub("r2i13-maria");
    const grant = await person.grantConsent("r2i13-maria", {
      orgAgentId: "org:r2i13-county",
      purpose: "renewal",
      scope: ["documents"],
      caseId: "case-r2i13",
    });
    const done = await person.approve(grant.approval!.id, "r2i13-maria");
    expect(done.status).toBe("completed");
    expect(done.receipt?.simulated).toBe(false);
  });

  it("item 18: records definite failures as failed and retries cleanly", async () => {
    const events: string[] = [];
    const calls: ActionRequest[] = [];
    const portal: Executor = {
      simulated: false,
      async execute(req) {
        calls.push(req);
        events.push("execute");
        if (calls.length === 1) throw new DefiniteFailureError("Sandbox portal rejected the action: 400");
        return { externalId: "portal-ok" };
      },
      async check() {
        events.push("check");
        return { found: false as const };
      },
    };
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, portal, { policyOverrides: { submit: "allow" } });
    const req = baseReq({ idempotencyKey: "r2i18-key" });
    const first = await gw.requestAction(req);
    expect(first.status).toBe("blocked");
    expect(first.reason).toMatch(/failed before anything happened/);
    expect(store.getAttempt("r2i18-key")?.status).toBe("failed");

    const retry = await gw.requestAction(req);
    expect(retry.status).toBe("completed");
    expect(calls.length).toBe(2);
    // No reconcile lookup on a clean retry: nothing could have happened.
    expect(events).toEqual(["execute", "execute"]);
  });
});
