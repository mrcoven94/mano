/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ActionGateway, MemoryApprovalStore, type ApprovalStore } from "../src/gateway/gateway.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";
import type { ActionRequest, Executor } from "../src/gateway/types.js";

// One action key has at most one live approval, and a NO is terminal for
// the key. Sol's repro: a retried /action made approval B beside A;
// rejecting A left B able to execute the same action. Run against both
// stores, the SQLite one through node:sqlite.

function openSqlStore(): ApprovalStore {
  const db = new DatabaseSync(":memory:");
  const storage = {
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
  ensureGatewayTables(storage as never);
  return new SqlApprovalStore(storage as never);
}

function setup(makeStore: () => ApprovalStore, checkerDelayMs = 0) {
  const store = makeStore();
  const executed: string[] = [];
  const exec: Executor = {
    simulated: true,
    async execute(req) {
      executed.push(req.idempotencyKey);
      return { externalId: `ext-${executed.length}` };
    },
    async check() {
      return { found: false as const };
    },
  };
  const gw = new ActionGateway(store, exec, {
    checker: {
      async check() {
        if (checkerDelayMs) await new Promise((r) => setTimeout(r, checkerDelayMs));
        return { verdict: "pass", problems: [] };
      },
    },
  });
  return { store, gw, executed };
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

const STORES: [string, () => ApprovalStore][] = [
  ["memory store", () => new MemoryApprovalStore()],
  ["SQLite store", openSqlStore],
];

for (const [label, makeStore] of STORES) {
  describe(`one approval per action key (${label})`, () => {
    it("Sol's repro: retry, reject the first, approve the second never executes", async () => {
      const { gw, executed } = setup(makeStore);
      const a = await gw.requestAction(request("r1-repro"));
      const b = await gw.requestAction(request("r1-repro"));
      expect(a.status).toBe("needs_approval");
      expect(b.approval?.id).toBe(a.approval?.id);
      expect((await gw.rejectApproval(a.approval!.id, "maria")).status).toBe("rejected");
      const approved = await gw.approveAndExecute(b.approval!.id, "maria");
      expect(approved.status).toBe("blocked");
      expect(executed).toEqual([]);
    });

    it("concurrent requests with one key create one approval", async () => {
      const { store, gw } = setup(makeStore, 30);
      const [a, b] = await Promise.all([gw.requestAction(request("r1-race")), gw.requestAction(request("r1-race"))]);
      expect(a.approval?.id).toBeDefined();
      expect(b.approval?.id).toBe(a.approval?.id);
      expect(store.getApprovalByKey("r1-race")?.id).toBe(a.approval?.id);
    });

    it("a rejected key stays declined on retry", async () => {
      const { gw, executed } = setup(makeStore);
      const a = await gw.requestAction(request("r1-terminal"));
      await gw.rejectApproval(a.approval!.id, "maria");
      const retry = await gw.requestAction(request("r1-terminal"));
      expect(retry.status).toBe("blocked");
      expect(retry.reason).toMatch(/declined/i);
      expect(executed).toEqual([]);
    });

    it("duplicates left from before the fix: one NO ends them all, atomically", async () => {
      const { store, gw, executed } = setup(makeStore);
      const a = await gw.requestAction(request("r1-legacy"));
      const legacyB = { ...store.getApproval(a.approval!.id)!, id: "legacy-b", createdAt: new Date().toISOString() };
      store.putApproval(legacyB);
      expect((await gw.rejectApproval(a.approval!.id, "maria")).status).toBe("rejected");
      expect(store.getApproval("legacy-b")?.status).toBe("rejected");
      expect((await gw.approveAndExecute("legacy-b", "maria")).status).toBe("blocked");
      expect(executed).toEqual([]);
    });

    it("the execution claim refuses a key declined during the approve's checks", async () => {
      const { store, gw, executed } = setup(makeStore, 60);
      const a = await gw.requestAction(request("r1-claim"));
      store.putApproval({ ...store.getApproval(a.approval!.id)!, id: "legacy-claim-b" });
      const approving = gw.approveAndExecute("legacy-claim-b", "maria");
      // The decline lands on A alone while B's approve awaits its checker,
      // after every earlier check passed: only the claim can stop it.
      await new Promise((r) => setTimeout(r, 20));
      store.putApproval({ ...store.getApproval(a.approval!.id)!, status: "rejected" });
      const result = await approving;
      expect(result.status).toBe("blocked");
      expect(result.reason).toMatch(/declined/i);
      expect(executed).toEqual([]);
    });
  });
}
