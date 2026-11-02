import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MapDocumentStore,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: `key-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("blocker 3: the approval executes the stored request", () => {
  it("goes stale when the server-side document changes after approval", async () => {
    const docs = new MapDocumentStore(new Map([["doc-b3", "Form v1: renewal"]]));
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(new MemoryApprovalStore(), exec, { documents: docs });
    const first = await gw.requestAction(baseReq({ documentId: "doc-b3", personId: "b3maria" }));
    expect(first.status).toBe("needs_approval");

    docs.set("doc-b3", "Form v2: CHANGED");
    const result = await gw.approveAndExecute(first.approval!.id, "b3maria");
    expect(result.status).toBe("stale");
    expect(exec.calls.length).toBe(0);
  });

  it("executes the stored recipient, purpose and payload, not caller input", async () => {
    const docs = new MapDocumentStore(new Map([["doc-b3b", "Form v1"]]));
    const exec = new InMemoryExecutor();
    const gw = new ActionGateway(new MemoryApprovalStore(), exec, { documents: docs });
    const first = await gw.requestAction(
      baseReq({
        recipient: "sandbox-agency",
        purpose: "renewal",
        payload: { form: "A" },
        documentId: "doc-b3b",
        personId: "b3maria",
      }),
    );
    const result = await gw.approveAndExecute(first.approval!.id, "b3maria");
    expect(result.status).toBe("completed");
    expect(exec.calls.length).toBe(1);
    expect(exec.calls[0].recipient).toBe("sandbox-agency");
    expect(exec.calls[0].purpose).toBe("renewal");
    expect(exec.calls[0].payload).toEqual({ form: "A" });
    expect(result.receipt?.recipient).toBe("sandbox-agency");
  });

  it("blocks when the referenced document is missing server-side", async () => {
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      documents: new MapDocumentStore(),
    });
    const result = await gw.requestAction(baseReq({ documentId: "nope" }));
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/not found/i);
  });
});
