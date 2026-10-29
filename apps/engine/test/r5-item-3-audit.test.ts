import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 5, item 3 through the real gateway, tightened in round 7: the
// audit log keeps only a hash of a blocked URL, never its host, path or
// query, all of which the caller chose.

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "send",
    recipient: "sandbox-agency",
    purpose: "notice",
    payload: {},
    idempotencyKey: `r5i3-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
    ...over,
  };
}

describe("r5 item 3: audit log redacts blocked URLs", () => {
  it("logs only a hash of the URL", async () => {
    const store = new MemoryApprovalStore();
    const gw = new ActionGateway(store, new InMemoryExecutor(), {
      linkCheck: async () => ({ allowed: false, reason: "Blocked domain." }),
    });
    const url = "https://portal.example.com/renewal/form?case=Victim-Case-9&ssn=1234";
    const result = await gw.requestAction(baseReq({ payload: { url } }));
    expect(result.status).toBe("blocked");

    const blocks = store.auditLog.filter((e) => e.event === "gateway.link_block");
    expect(blocks.length).toBe(1);
    const logged = JSON.stringify(blocks[0]);
    expect(logged).not.toContain("portal.example.com");
    expect(logged).not.toContain("/renewal/form");
    expect(logged).not.toContain("Victim-Case-9");
    expect(logged).not.toContain("ssn=1234");
    expect(blocks[0].urlHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
