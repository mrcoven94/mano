/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureAgentStateTables, removeConversationState } from "../src/agents/agent-state.js";
import {
  bindFillReplay,
  ensureFillReplayTables,
  finishLinkCleanup,
  getFillReplay,
  linkKey,
  removeFillReplays,
  replayPage,
  type ReplayLinkEntry,
  type ReplayStorage,
} from "../src/fill-replay.js";
import { ActionGateway } from "../src/gateway/gateway.js";
import { InMemoryExecutor } from "../src/gateway/executors.js";
import { SqlApprovalStore, ensureGatewayTables } from "../src/gateway/sql-store.js";

// A replay on real SQLite, where the Durable Object's waits are made
// visible: what another request does while the page reads, and what a
// bind or a delete leaves behind when storage fails partway.

function openDb() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const head = query.trimStart().toUpperCase();
      if (head.startsWith("SELECT") || head.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const info = db.prepare(query).run(...(bindings as never[]));
      return { toArray: () => [], rowsWritten: Number(info.changes) };
    },
  };
  ensureGatewayTables(sql as never);
  ensureAgentStateTables(sql);
  ensureFillReplayTables(sql);
  // PersonAgent's own table, which a conversation delete clears too.
  sql.exec("CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)");
  return sql;
}

const png = (marker: number) =>
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 5, 0, 0, 0, 3, 32, 8, 6, 0, 0, 0, 0, 0, 0, 0, marker]);
const INPUT = { labels: { fullName: "Full legal name" }, steps: [1, 2, 3].map((m) => ({ caption: `Step ${m}.`, png: png(m), focus: null })) };

class MemoryStorage implements ReplayStorage {
  objects = new Map<string, Uint8Array | ReplayLinkEntry>();
  failImageAt: number | null = null;
  failLink = false;
  failDeletes = 0;
  // Runs while an image is read, the way another request to the same
  // person can run while the Durable Object waits on R2.
  duringRead: (() => void) | null = null;
  async putImage(id: string, bytes: Uint8Array, generation: number) {
    if (this.failImageAt !== null && id.endsWith(`-${this.failImageAt}`)) throw new Error("R2 put failed");
    const r2Key = `persons/p/docs/g${generation}/${id}.${bytes[bytes.length - 1]}`;
    this.objects.set(r2Key, bytes);
    return { hash: String(bytes[bytes.length - 1]), r2Key };
  }
  async getImage(_id: string, r2Key: string) {
    this.duringRead?.();
    this.duringRead = null;
    return (this.objects.get(r2Key) as Uint8Array | undefined) ?? null;
  }
  async deleteObjects(keys: string[]) {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("R2 delete failed");
    }
    for (const k of keys) this.objects.delete(k);
  }
  async putLink(key: string, entry: ReplayLinkEntry) {
    if (this.failLink) throw new Error("R2 put failed");
    this.objects.set(key, entry);
  }
}

async function setup() {
  const sql = openDb();
  const store = new SqlApprovalStore(sql as never);
  const gateway = new ActionGateway(store, new InMemoryExecutor(), { linkCheck: async () => ({ allowed: true }) });
  const proposed = await gateway.requestAction({
    type: "submit",
    recipient: "sandbox-agency-portal",
    purpose: "Food benefits renewal in the sandbox agency portal",
    payload: { fullName: "Rosa Testcase" },
    idempotencyKey: "replay-node-1",
    actor: "foreground",
    personId: "p",
    sources: [],
    origin: "person",
  });
  const storage = new MemoryStorage();
  const deps = { sql, approvals: store, storage, personId: "p", nowMs: Date.now() };
  return { sql, store, gateway, storage, deps, approvalId: proposed.approval!.id };
}

describe("a replay while other requests run", () => {
  it("a decline that lands while the page reads its images shows the closed page, not the old steps", async () => {
    const { sql, store, gateway, storage, deps, approvalId } = await setup();
    const bound = await bindFillReplay(deps, approvalId, INPUT, 0);
    if (bound.status !== "created") throw new Error(bound.status);
    const view = () => replayPage({ ...deps, exact: (a) => gateway.stillExact(a) }, approvalId, bound.token);
    expect(await view()).toContain("This is exactly what Mano will send");

    storage.duringRead = () => sql.exec("UPDATE approvals SET status = 'rejected' WHERE id = ?", approvalId);
    const page = (await view())!;
    expect(page).toContain("This form is closed");
    expect(page).not.toContain("<img");
    expect(store.getApproval(approvalId)?.status).toBe("rejected");
  });

  it("a conversation delete that lands while the page reads shows nothing", async () => {
    const { sql, gateway, storage, deps, approvalId } = await setup();
    const bound = await bindFillReplay(deps, approvalId, INPUT, 0);
    if (bound.status !== "created") throw new Error(bound.status);
    storage.duringRead = () => {
      removeConversationState(sql, Date.now(), 1);
      removeFillReplays(sql);
    };
    expect(await replayPage({ ...deps, exact: (a) => gateway.stillExact(a) }, approvalId, bound.token)).toBeNull();
  });
});

describe("storage that fails partway", () => {
  it("an image that fails to store leaves no other image behind and no row", async () => {
    const { sql, storage, deps, approvalId } = await setup();
    storage.failImageAt = 2;
    await expect(bindFillReplay(deps, approvalId, INPUT, 0)).rejects.toThrow("R2 put failed");
    expect(storage.objects.size).toBe(0);
    expect(getFillReplay(sql, approvalId)).toBeNull();
  });

  it("a link that fails to store leaves none of the images", async () => {
    const { sql, storage, deps, approvalId } = await setup();
    storage.failLink = true;
    await expect(bindFillReplay(deps, approvalId, INPUT, 0)).rejects.toThrow("R2 put failed");
    expect(storage.objects.size).toBe(0);
    expect(getFillReplay(sql, approvalId)).toBeNull();
  });

  it("a delete whose link cleanup fails finishes it on the next call", async () => {
    const { sql, storage, deps, approvalId } = await setup();
    const bound = await bindFillReplay(deps, approvalId, INPUT, 0);
    if (bound.status !== "created") throw new Error(bound.status);
    const key = await linkKey(bound.token);
    removeConversationState(sql, Date.now(), 1);
    removeFillReplays(sql);
    storage.failDeletes = 1;
    await expect(finishLinkCleanup(sql, (keys) => storage.deleteObjects(keys))).rejects.toThrow("R2 delete failed");
    expect(storage.objects.has(key)).toBe(true);
    await finishLinkCleanup(sql, (keys) => storage.deleteObjects(keys));
    expect(storage.objects.has(key)).toBe(false);
    expect(sql.exec("SELECT link_key FROM fill_link_cleanup").toArray()).toEqual([]);
  });
});
