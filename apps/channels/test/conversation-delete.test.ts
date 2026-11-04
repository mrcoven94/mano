import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AgentResponder } from "@mano/channels";

import { buildResponder } from "../src/conversation.js";
import {
  advanceDelete,
  clearPendingDelete,
  isDone,
  loadPendingDelete,
  newPendingDelete,
  retryDelayMs,
  savePendingDelete,
} from "../src/conversation-delete.js";
import type { Env } from "../src/env.js";

const HANDLE = "c".repeat(64);

function sql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = query.trimStart().toUpperCase().startsWith("SELECT")
        ? (db.prepare(query).all(...(bindings as never[])) as unknown[])
        : (db.prepare(query).run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
  };
}

const env = {
  MANO_ENGINE_URL: "https://engine.example",
  MANO_ENGINE_CHANNELS_TOKEN: "channels-token",
  MANO_HANDLE_GRANT_SECRET: "grant-secret",
  AGENT_URL: "https://agent.example",
  MANO_AGENT_SECRET: "agent-secret",
} as unknown as Env;

function fakes(opts: { engine: "down" | "stale" | "ok"; agent: boolean }) {
  return (async (url: string) => {
    if (url.includes("/conversation")) {
      if (opts.engine === "down") return new Response("unavailable", { status: 503 });
      return Response.json({ removed: { generation: opts.engine === "ok" ? 1 : 0 } });
    }
    return opts.agent ? Response.json({ ok: true }) : new Response("no", { status: 502 });
  }) as typeof fetch;
}

describe("a conversation delete that reaches Engine and the agent", () => {
  it("stays pending until Engine reports the new generation", async () => {
    const fresh = newPendingDelete(env, HANDLE, 1);
    const down = await advanceDelete(env, fresh, fakes({ engine: "down", agent: true }));
    expect(isDone(down.pending)).toBe(false);
    expect(down.pending).toMatchObject({ engineDone: false, agentDone: true });
    // An answer that does not reach the new generation is not a confirmation.
    const stale = await advanceDelete(env, down.pending, fakes({ engine: "stale", agent: true }));
    expect(stale.pending.engineDone).toBe(false);
    const ok = await advanceDelete(env, stale.pending, fakes({ engine: "ok", agent: true }));
    expect(isDone(ok.pending)).toBe(true);
  });

  it("keeps the file deletion owed until it succeeds", async () => {
    const withFiles = { ...env, FILES: {} } as unknown as Env;
    const fresh = newPendingDelete(withFiles, HANDLE, 1);
    const failed = await advanceDelete(withFiles, fresh, fakes({ engine: "ok", agent: true }), async () => {
      throw new Error("R2 unavailable");
    });
    expect(failed.pending).toMatchObject({ filesDone: false, engineDone: true, agentDone: true });
    expect(isDone(failed.pending)).toBe(false);
    const ok = await advanceDelete(withFiles, failed.pending, fakes({ engine: "ok", agent: true }), async () => undefined);
    expect(isDone(ok.pending)).toBe(true);
  });

  it("is persisted across restarts and backs off", () => {
    const db = sql();
    savePendingDelete(db, { ...newPendingDelete(env, HANDLE, 1), attempts: 2, nextAtMs: 5 });
    expect(loadPendingDelete(db)).toMatchObject({ handleHash: HANDLE, generation: 1, filesDone: true, engineDone: false, attempts: 2, nextAtMs: 5 });
    clearPendingDelete(db);
    expect(loadPendingDelete(db)).toBeNull();
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });

  it("while pending, the conversation answers without the agent", () => {
    const base = { ...env, META_MODEL_API_KEY: "k", MANO_REPLY_MODEL: "muse-spark-1.3" } as unknown as Env;
    expect(buildResponder(base, HANDLE)).toBeInstanceOf(AgentResponder);
    expect(buildResponder(base, HANDLE, { agentAllowed: false })).not.toBeInstanceOf(AgentResponder);
  });
});
