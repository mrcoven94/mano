/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import { DefiniteFailureError, TimeoutError } from "../src/gateway/types.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";
import { currentGeneration, ensureAgentStateTables, removeConversationState } from "../src/agents/agent-state.js";

// The conversation generation fence on the gateway, on real SQLite. A
// delete lands while a request is in its awaited preparation; the commit
// point (approval insert, execution claim, retry adopt, recovery adopt)
// re-checks the generation and nothing is written or executed. Approved
// actions that had not finished are revoked: they still reconcile, but
// never execute again.

function open(checkerDelayMs = 0, policyOverrides?: Record<string, "allow" | "ask">) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const trimmed = query.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureGatewayTables(sql as never);
  ensureAgentStateTables(sql);
  sql.exec("CREATE TABLE memory(id TEXT PRIMARY KEY, content TEXT NOT NULL)");
  const store = new SqlApprovalStore(sql as never);
  const executed: string[] = [];
  const behavior = { execute: "ok" as "ok" | "timeout" | "fail", found: false };
  const exec: Executor = {
    simulated: true,
    async execute(req) {
      executed.push(req.idempotencyKey);
      if (behavior.execute === "timeout") throw new TimeoutError();
      if (behavior.execute === "fail") throw new DefiniteFailureError("Sandbox portal rejected the action: 400");
      return { externalId: "ext-1" };
    },
    async check() {
      return behavior.found ? { found: true as const, externalId: "ext-1" } : { found: false as const };
    },
  };
  let delayOnce: (() => void) | null = null;
  const gw = new ActionGateway(store, exec, {
    policyOverrides,
    checker: {
      async check() {
        if (checkerDelayMs) await new Promise((r) => setTimeout(r, checkerDelayMs));
        delayOnce?.();
        delayOnce = null;
        return { verdict: "pass", problems: [] };
      },
    },
  });
  const deleteConversation = () => removeConversationState(sql, Date.now(), currentGeneration(sql) + 1);
  const duringChecks = (fn: () => void) => {
    delayOnce = fn;
  };
  return { sql, store, gw, executed, behavior, deleteConversation, duringChecks };
}

function request(key: string): ActionRequest {
  return {
    type: "submit",
    recipient: "sandbox-agency",
    purpose: "renewal",
    payload: {},
    idempotencyKey: key,
    actor: "foreground",
    personId: "maria",
    sources: [],
    origin: "person",
  };
}

const count = (sql: ReturnType<typeof open>["sql"], table: string) =>
  (sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0] as { n: number }).n;

describe("generation fence on the gateway", () => {
  it("an old turn resuming after a delete inserts no approval", async () => {
    const { sql, gw, duringChecks, deleteConversation } = open(20);
    duringChecks(deleteConversation);
    const result = await gw.requestAction(request("f-approval"), new Date(), { generation: 0 });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/conversation was deleted/i);
    expect(count(sql, "approvals")).toBe(0);
    const late = await gw.requestAction(request("f-approval-late"), new Date(), { generation: 0 });
    expect(late.reason).toMatch(/conversation was deleted/i);
  });

  it("an allowed action prepared before a delete never claims or executes", async () => {
    const { sql, gw, executed, duringChecks, deleteConversation } = open(20, { submit: "allow" });
    duringChecks(deleteConversation);
    const result = await gw.requestAction(request("f-allow"), new Date(), { generation: 0 });
    expect(result.reason).toMatch(/conversation was deleted/i);
    expect(executed).toEqual([]);
    expect(count(sql, "attempts")).toBe(0);
  });

  it("an approve whose checks span a generation change never claims", async () => {
    const { sql, store, gw, executed, duringChecks } = open(20);
    const pending = await gw.requestAction(request("f-claim"), new Date(), { generation: 0 });
    // Only the generation moves, not the approval row, so the claim's
    // own fence is what refuses.
    duringChecks(() => sql.exec("UPDATE conversation_state SET generation = 1 WHERE slot = 1"));
    const result = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(result.reason).toMatch(/conversation was deleted/i);
    expect(executed).toEqual([]);
    expect(store.getApproval(pending.approval!.id)?.status).toBe("pending");
  });

  it("a consumed-approval retry revoked during its checks never executes", async () => {
    const { gw, executed, behavior, duringChecks, deleteConversation } = open(20);
    behavior.execute = "fail";
    const pending = await gw.requestAction(request("f-retry"), new Date(), { generation: 0 });
    expect((await gw.approveAndExecute(pending.approval!.id, "maria")).status).toBe("blocked");
    expect(executed.length).toBe(1);
    behavior.execute = "ok";
    duringChecks(deleteConversation);
    const retry = await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(retry.status).toBe("blocked");
    expect(retry.reason).toMatch(/revoked/i);
    expect(executed.length).toBe(1);
  });

  it("a delete revokes an unresolved approved action: it reconciles, but never executes again", async () => {
    const { store, gw, executed, behavior, deleteConversation } = open();
    behavior.execute = "timeout";
    const pending = await gw.requestAction(request("f-revoke"), new Date(), { generation: 0 });
    await gw.approveAndExecute(pending.approval!.id, "maria");
    expect(store.getAttempt("f-revoke")?.status).toBe("unknown");
    expect(deleteConversation().approvalsRevoked).toBe(1);
    expect(store.getApproval(pending.approval!.id)?.status).toBe("revoked");

    behavior.execute = "ok";
    const later = new Date(Date.now() + 3600_000).toISOString();
    const recovered = await gw.recoverAttempt("f-revoke", new Date(), later);
    expect(recovered?.status).toBe("blocked");
    expect((await gw.approveAndExecute(pending.approval!.id, "maria")).status).toBe("blocked");
    expect(executed.length).toBe(1);

    // Reconciliation still settles it when the outside system has it.
    store.updateAttempt("f-revoke", "unknown");
    behavior.found = true;
    const reconciled = await gw.recoverAttempt("f-revoke", new Date(), later);
    expect(reconciled?.status).toBe("reconciled");
    expect(executed.length).toBe(1);
  });
});
