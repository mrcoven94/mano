import { describe, expect, it } from "vitest";
import {
  ActionGateway,
  InMemoryExecutor,
  LocalRulesChecker,
  MemoryApprovalStore,
} from "../src/gateway/index.js";
import type { ActionRequest, Checker, CheckInput } from "../src/gateway/index.js";

function baseReq(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: { form: "A" },
    idempotencyKey: `key-${crypto.randomUUID()}`,
    actor: "foreground",
    personId: "maria",
    sources: [{ kind: "document", id: "doc-1" }],
    origin: "person",
    ...over,
  };
}

describe("item 16: the Checker hook", () => {
  it("passes the exact input shape to the checker", async () => {
    let seen: CheckInput | null = null;
    const spy: Checker = {
      async check(input) {
        seen = input;
        return { verdict: "pass", problems: [] };
      },
    };
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      checker: spy,
      listConsents: () => [{ recipient: "org:county", purpose: "renewal" }],
    });
    await gw.requestAction(baseReq());
    expect(seen).toEqual({
      action: {
        type: "submit",
        recipient: "sandbox-agency",
        purpose: "renewal",
        payload: { form: "A" },
        documentHash: null,
      },
      sources: [{ kind: "document", id: "doc-1" }],
      consents: [{ recipient: "org:county", purpose: "renewal" }],
      origin: "person",
    });
  });

  it("blocks on a block verdict and on checker failure or timeout", async () => {
    const block: Checker = {
      async check() {
        return { verdict: "block", problems: ["forged evidence"] };
      },
    };
    const gw = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), { checker: block });
    const blocked = await gw.requestAction(baseReq());
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toMatch(/forged evidence/);

    const throwing: Checker = {
      async check() {
        throw new Error("checker down");
      },
    };
    const gw2 = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), { checker: throwing });
    expect((await gw2.requestAction(baseReq())).status).toBe("blocked");

    const slow: Checker = {
      check: () => new Promise(() => {}),
    };
    const gw3 = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      checker: slow,
      checkerTimeoutMs: 20,
    });
    expect((await gw3.requestAction(baseReq())).status).toBe("blocked");
  });

  it("attaches fix problems to the approval on ask, and blocks on allow", async () => {
    const fix: Checker = {
      async check() {
        return { verdict: "fix", problems: ["needs a human look"] };
      },
    };
    const ask = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), { checker: fix });
    const pending = await ask.requestAction(baseReq());
    expect(pending.status).toBe("needs_approval");
    expect(pending.approval?.problems).toEqual(["needs a human look"]);

    const allow = new ActionGateway(new MemoryApprovalStore(), new InMemoryExecutor(), {
      checker: fix,
      policyOverrides: { submit: "allow" },
    });
    const blocked = await allow.requestAction(baseReq());
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toMatch(/needs a human look/);
  });

  it("local rules flag content origin and uncovered shares", async () => {
    const checker = new LocalRulesChecker();
    const content = await checker.check({
      action: { type: "send", recipient: "x", purpose: "y", payload: {}, documentHash: null },
      sources: [],
      consents: [],
      origin: "content",
    });
    expect(content.verdict).toBe("fix");

    const uncovered = await checker.check({
      action: { type: "share", recipient: "org:a", purpose: "p", payload: {}, documentHash: null },
      sources: [],
      consents: [],
      origin: "person",
    });
    expect(uncovered.verdict).toBe("fix");

    const covered = await checker.check({
      action: { type: "share", recipient: "org:a", purpose: "p", payload: {}, documentHash: null },
      sources: [],
      consents: [{ recipient: "org:a", purpose: "p" }],
      origin: "person",
    });
    expect(covered).toEqual({ verdict: "pass", problems: [] });

    const plain = await checker.check({
      action: { type: "submit", recipient: "x", purpose: "y", payload: {}, documentHash: null },
      sources: [],
      consents: [],
      origin: "person",
    });
    expect(plain.verdict).toBe("pass");
  });
});
