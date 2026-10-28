/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ConversationDO } from "../src/conversation.js";
import type { Env } from "../src/env.js";

// Runs the real ConversationDO against node:sqlite, so alarm behavior
// (not observable through the worker's public surface) is pinned here.
// The adapter maps the few SqlStorage calls the stores use.
function sqliteStorage(db: DatabaseSync): SqlStorage {
  return {
    exec(sql: string, ...params: unknown[]) {
      const select = /^\s*(SELECT|WITH)\b/i.test(sql);
      if (!select && params.length === 0 && sql.includes(";")) {
        db.exec(sql);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(sql);
      const args = params as SQLInputValue[];
      if (select) return { toArray: () => stmt.all(...args) };
      stmt.run(...args);
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
}

function testDo(opts: { batchMs?: string; failSpendReserve?: () => boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const ctx = {
    id: { name: "alarm-test", toString: () => "alarm-test" },
    storage: {
      sql: sqliteStorage(db),
      setAlarm: async (ms: number) => {
        alarm = ms;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  } as unknown as DurableObjectState;
  const stateStub = {
    fetch: async (url: string) => {
      if (url.endsWith("/internal/spend-reserve") && opts.failSpendReserve?.()) {
        throw new Error("ledger down");
      }
      return new Response(JSON.stringify({ ok: true }));
    },
  };
  const env = {
    CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stateStub },
    TURN_BATCH_MS: opts.batchMs ?? "2500",
    MANO_HANDLE_PEPPER: "test-pepper-not-real",
  } as unknown as Env;
  const postEvent = async (event: Record<string, unknown>): Promise<string> => {
    const res = await new ConversationDO(ctx, env).fetch(
      new Request("https://conversation/internal/event", {
        method: "POST",
        body: JSON.stringify({ handleHash: "hash-alarm", event }),
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: string }).result;
  };
  const postTurn = async (): Promise<string> => {
    const res = await new ConversationDO(ctx, env).fetch(
      new Request("https://conversation/internal/turn", {
        method: "POST",
        body: JSON.stringify({ handleHash: "hash-alarm" }),
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: string }).result;
  };
  return {
    postEvent,
    postTurn,
    get alarm() {
      return alarm;
    },
    clearAlarm() {
      alarm = null;
    },
  };
}

function inbound(id: string): Record<string, unknown> {
  return {
    id,
    kind: "message.received",
    rawType: "message.received",
    channelId: "ch_test_line",
    channelType: "blooio",
    chatId: "chat_alarm",
    messageId: `msg_${id}`,
    group: null,
    handle: "+15550001001",
    direction: "inbound",
    text: "Hello.",
    attachments: [],
    errorCode: null,
    errorMessage: null,
    occurredAtMs: Date.now(),
  };
}

describe("duplicate redelivery and the batch alarm", () => {
  it("re-arms the alarm when pending input waits with none", async () => {
    const d = testDo();
    expect(await d.postEvent(inbound("evt_alarm_1"))).toBe("queued");
    expect(d.alarm).not.toBeNull();
    d.clearAlarm();
    expect(await d.postEvent(inbound("evt_alarm_1"))).toBe("duplicate");
    expect(d.alarm).not.toBeNull();
  });

  it("leaves the alarm alone when nothing waits", async () => {
    const d = testDo();
    const receipt = { ...inbound("evt_alarm_rcpt"), kind: "message.delivered", rawType: "message.delivered", direction: "outbound", text: null };
    expect(await d.postEvent(receipt)).toBe("recorded");
    expect(d.alarm).toBeNull();
    expect(await d.postEvent(receipt)).toBe("duplicate");
    expect(d.alarm).toBeNull();
  });

  it("re-arms with backoff when a turn errors on infrastructure", async () => {
    let down = true;
    const d = testDo({ batchMs: "0", failSpendReserve: () => down });
    expect(await d.postEvent(inbound("evt_alarm_retry"))).toBe("queued");
    d.clearAlarm();
    const before = Date.now();
    expect(await d.postTurn()).toBe("retry");
    expect(d.alarm).not.toBeNull();
    expect(d.alarm! - before).toBeGreaterThanOrEqual(4000);
    expect(d.alarm! - before).toBeLessThanOrEqual(6000);
    down = false;
    // The ledger answers but refuses the budget (stub shape): the turn
    // reaches its final limited outcome instead of retrying forever.
    expect(await d.postTurn()).toBe("ran");
  });
});
