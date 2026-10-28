import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MapDocumentStore,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";
import type { PersonAgent } from "../src/agents/person-agent.js";

// Item 6: an attempt left in_flight by a restart is recovered against the
// stored request, without asking the person to approve again.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    documentId: "doc-1",
    payload: {},
    idempotencyKey: `r2i6-${crypto.randomUUID()}`,
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

describe("r2 item 6: stranded attempts recover from the stored request", () => {
  it("executes a stranded approve-path attempt after re-verifying", async () => {
    const docs = new MapDocumentStore(new Map([["doc-1", "Form v1"]]));
    const exec = new InMemoryExecutor();
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, exec, { documents: docs });
    const first = await gw.requestAction(baseReq({ idempotencyKey: "r2i6-stranded" }));
    expect(first.status).toBe("needs_approval");
    // Simulate the crash: consume, then strand the attempt in the past.
    const approval = store.getApproval(first.approval!.id)!;
    approval.status = "approved";
    approval.approvedByHumanId = "maria";
    store.putApproval(approval);
    store.insertAttempt({
      key: "r2i6-stranded",
      status: "in_flight",
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      requestHash: "",
      actionType: "submit",
      recipient: "sandbox-agency",
      personId: "maria",
    });

    const recovered = await gw.recoverAttempt("r2i6-stranded", new Date(), new Date(Date.now() - 300_000).toISOString());
    expect(recovered?.status).toBe("completed");
    expect(exec.calls.length).toBe(1);
    expect(exec.calls[0].payload).toEqual({});
    expect(store.getAttempt("r2i6-stranded")?.status).toBe("done");
  });

  it("refuses recovery when the document changed after approval", async () => {
    const docs = new MapDocumentStore(new Map([["doc-1", "Form v1"]]));
    const exec = new InMemoryExecutor();
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, exec, { documents: docs });
    const first = await gw.requestAction(baseReq({ idempotencyKey: "r2i6-changed" }));
    const approval = store.getApproval(first.approval!.id)!;
    approval.status = "approved";
    approval.approvedByHumanId = "maria";
    store.putApproval(approval);
    store.insertAttempt({
      key: "r2i6-changed",
      status: "in_flight",
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      requestHash: "",
      actionType: "submit",
      recipient: "sandbox-agency",
      personId: "maria",
    });
    docs.set("doc-1", "Form v2: CHANGED");

    const recovered = await gw.recoverAttempt("r2i6-changed", new Date(), new Date(Date.now() - 300_000).toISOString());
    expect(recovered?.status).toBe("stale");
    expect(exec.calls.length).toBe(0);
  });

  it("reconciles a stranded allow-path attempt without re-executing", async () => {
    const exec = new InMemoryExecutor();
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, exec, { policyOverrides: { submit: "allow" } });
    const req = baseReq({ idempotencyKey: "r2i6-allow", documentId: undefined });
    // The executor ran before the crash, but no receipt was recorded.
    await exec.execute(req);
    store.insertAttempt({
      key: "r2i6-allow",
      status: "in_flight",
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      requestHash: "",
      actionType: "submit",
      recipient: "sandbox-agency",
      personId: "maria",
    });

    const recovered = await gw.recoverAttempt("r2i6-allow", new Date(), new Date(Date.now() - 300_000).toISOString());
    expect(recovered?.status).toBe("reconciled");
    expect(recovered?.receipt?.externalId).toBe("sim-1");
    expect(exec.calls.length).toBe(1);
  });

  it("exposes recovery on the person agent", async () => {
    const person = personStub("r2i6-agent");
    const out = await person.recoverStrandedAttempts(60_000);
    expect(out.recovered).toEqual([]);
  });
});
