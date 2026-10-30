/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingChannel, type NormalizedEvent } from "@mano/channels";
import { ConversationDO } from "../src/conversation.js";
import type { Env } from "../src/env.js";
import { reconcile, routeEvent } from "../src/index.js";

// Sol's review 9: an inbound sent before STOP but delivered after it (a
// late webhook, or the reconcile feed) cleared the opt-out, and Mano
// texted again. Runs the real ConversationDO on node:sqlite, fed by the
// worker's own routeEvent and reconcile.
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

const LINE = "ch_test_line";
const PERSON = "+15550001001";
const CHAT = "chat_optout";

function world() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const ctx = {
    id: { name: "optout-test", toString: () => "optout-test" },
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
  const seen = new Set<string>();
  let cursor: string | null = null;
  const state = {
    fetch: async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { cursor?: string | null; ids?: string[] }) : {};
      if (url.endsWith("/internal/cursor") && init?.method === "POST") {
        cursor = body.cursor ?? null;
        return Response.json({ ok: true });
      }
      if (url.endsWith("/internal/cursor")) return Response.json({ cursor });
      if (url.endsWith("/internal/seen-check")) return Response.json({ unseen: (body.ids ?? []).filter((id) => !seen.has(id)) });
      if (url.endsWith("/internal/seen-note")) {
        for (const id of body.ids ?? []) seen.add(id);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true, allowed: true, spentUsd: 0 });
    },
  };
  const queued: NormalizedEvent[] = [];
  const env = {
    CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => state },
    EVENTS: { send: async (event: NormalizedEvent) => void queued.push(event) },
    TURN_BATCH_MS: "0",
    MANO_HANDLE_PEPPER: "test-pepper-not-real",
    BLOOIO_CHANNEL_ID: LINE,
    BLOOIO_API_KEY: "",
  } as unknown as Env;
  (env as unknown as { CONVERSATION: unknown }).CONVERSATION = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: (url: string, init?: RequestInit) => new ConversationDO(ctx, env).fetch(new Request(url, init)) }),
  };
  const conversation = () => new ConversationDO(ctx, env);
  return {
    env,
    queued,
    // The queue consumer's path: every webhook and reconciled event.
    deliver: async (event: NormalizedEvent) => routeEvent(event, env),
    turn: async () => {
      const res = await conversation().fetch(new Request("https://conversation/internal/turn", { method: "POST", body: JSON.stringify({ handleHash: "h" }) }));
      return ((await res.json()) as { result: string }).result;
    },
    state: async () =>
      (await (await conversation().fetch(new Request("https://conversation/internal/standin"))).json()) as {
        sends: { key: string; state: string; code: string | null }[];
        pending: number;
      },
  };
}

function inbound(id: string, text: string, occurredAtMs: number | null): NormalizedEvent {
  return {
    id,
    kind: "message.received",
    rawType: "message.received",
    channelId: LINE,
    channelType: "blooio",
    channelAddress: null,
    chatId: CHAT,
    messageId: `msg_${id}`,
    group: null,
    handle: PERSON,
    direction: "inbound",
    text,
    attachments: [],
    errorCode: null,
    errorMessage: null,
    occurredAtMs,
  };
}

const sentTexts = (s: { sends: { state: string; code: string | null }[] }) => s.sends.filter((o) => o.state === "sent").length;

afterEach(() => {
  vi.useRealTimers();
});

describe("an inbound sent before STOP but delivered after it", () => {
  it("by webhook: recorded, never clears the opt-out, never starts a turn", async () => {
    const w = world();
    const t0 = Date.now();
    await w.deliver(inbound("evt_hi", "Hello", t0 - 30_000));
    await w.turn();
    await w.deliver(inbound("evt_stop", "STOP", t0 - 10_000));
    const afterStop = sentTexts(await w.state());
    // Sent between the two, delivered late.
    await w.deliver(inbound("evt_late", "One more question", t0 - 20_000));
    // Sent at the same instant as STOP: not after it.
    await w.deliver(inbound("evt_same", "And another", t0 - 10_000));
    expect((await w.state()).pending).toBe(0);
    await w.turn();
    expect(sentTexts(await w.state())).toBe(afterStop);

    // A message sent after STOP re-engages, per the product rule.
    await w.deliver(inbound("evt_back", "Hi again", t0 - 5_000));
    expect((await w.state()).pending).toBe(1);
    await w.turn();
    expect(sentTexts(await w.state())).toBeGreaterThan(afterStop);
  });

  it("by the reconcile feed: the same", async () => {
    const w = world();
    const t0 = Date.now();
    await w.deliver(inbound("evt_hi2", "Hello", t0 - 30_000));
    await w.turn();
    await w.deliver(inbound("evt_stop2", "STOP", t0 - 10_000));
    const afterStop = sentTexts(await w.state());
    const feed = new RecordingChannel();
    feed.feedPages = [[inbound("evt_missed", "Did you get my last text?", t0 - 20_000)]];
    expect(await reconcile(w.env, feed)).toEqual({ pages: 1, enqueued: 1 });
    for (const event of w.queued) await w.deliver(event);
    expect((await w.state()).pending).toBe(0);
    await w.turn();
    expect(sentTexts(await w.state())).toBe(afterStop);
  });

  it("an undated STOP is honored on Channels' clock, and only START or a message a minute later re-engages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-10-30T15:00:00Z");
    vi.setSystemTime(t0);
    const w = world();
    await w.deliver(inbound("evt_hi3", "Hello", t0 - 30_000));
    await w.turn();
    await w.deliver(inbound("evt_stop3", "STOP", null));
    const afterStop = sentTexts(await w.state());
    expect((await w.state()).sends.some((s) => s.key.includes("optout"))).toBe(true);
    vi.setSystemTime(t0 + 20_000);
    await w.deliver(inbound("evt_soon", "wait", t0 + 15_000));
    expect((await w.state()).pending).toBe(0);
    await w.turn();
    expect(sentTexts(await w.state())).toBe(afterStop);
    await w.deliver(inbound("evt_start", "START", t0 + 18_000));
    expect((await w.state()).pending).toBe(1);
  });
});
