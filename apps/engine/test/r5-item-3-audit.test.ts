import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest } from "../src/gateway/index.js";

// Round 5, item 3 through the real gateway: the audit log keeps the
// scheme, host and a hash of the rest of a blocked URL, never the path
// or query where personal details live.

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
  it("logs scheme, host and hash, never path or query", async () => {
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
    expect(logged).toContain("https://portal.example.com");
    expect(logged).not.toContain("/renewal/form");
    expect(logged).not.toContain("Victim-Case-9");
    expect(logged).not.toContain("ssn=1234");
    expect(blocks[0].url).toMatch(/^https:\/\/portal\.example\.com#[0-9a-f]{16}$/);
  });
});
