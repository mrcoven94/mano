import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";

const workerEnv = env as unknown as Env;

function stubFor(name: string): DurableObjectStub {
  return workerEnv.CONVERSATION.get(workerEnv.CONVERSATION.idFromName(name));
}

function inbound(id: string, text: string): Record<string, unknown> {
  return {
    id,
    kind: "message.received",
    rawType: "message.received",
    channelId: "ch_test_line",
    channelType: "blooio",
    chatId: "chat_worker_do",
    messageId: `msg_${id}`,
    handle: "+15550001001",
    direction: "inbound",
    text,
    attachments: [],
    errorCode: null,
    errorMessage: null,
    occurredAtMs: Date.now(),
  };
}

async function postEvent(stub: DurableObjectStub, handleHash: string, event: Record<string, unknown>): Promise<string> {
  const res = await stub.fetch("https://conversation/internal/event", {
    method: "POST",
    body: JSON.stringify({ handleHash, event }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: string }).result;
}

describe("ConversationDO on SQLite", () => {
  it("dedupes replayed events in its own storage", async () => {
    const stub = stubFor(`do-dedupe-${Date.now()}`);
    const event = inbound("evt_do_dup", "Hello.");
    expect(await postEvent(stub, "hash-dedupe", event)).toBe("queued");
    expect(await postEvent(stub, "hash-dedupe", event)).toBe("duplicate");
  });

  it("runs a turn with stand-ins and records sends", async () => {
    const stub = stubFor(`do-turn-${Date.now()}`);
    expect(await postEvent(stub, "hash-turn", inbound("evt_do_turn", "Hi Mano"))).toBe("queued");
    await new Promise((r) => setTimeout(r, 3000));
    const turn = await stub.fetch("https://conversation/internal/turn", {
      method: "POST",
      body: JSON.stringify({ handleHash: "hash-turn" }),
    });
    expect(turn.status).toBe(200);
    const outcome = ((await turn.json()) as { result: string }).result;
    expect(["ran", "idle"]).toContain(outcome);
    const standin = await stub.fetch("https://conversation/internal/standin");
    expect(standin.status).toBe(200);
    const recorded = (await standin.json()) as {
      sends: Array<{ key: string; state: string; message: string | null }>;
      turn: number;
      introduced: boolean;
      pending: number;
    };
    expect(recorded.turn).toBe(1);
    expect(recorded.introduced).toBe(true);
    expect(recorded.pending).toBe(0);
    expect(recorded.sends.length).toBeGreaterThan(0);
    expect(recorded.sends.every((s) => s.state === "sent" && !!s.message)).toBe(true);
  });

  it("keeps conversations isolated per handle", async () => {
    const a = stubFor(`do-iso-a-${Date.now()}`);
    const b = stubFor(`do-iso-b-${Date.now()}`);
    expect(await postEvent(a, "hash-a", inbound("evt_same_id", "For A."))).toBe("queued");
    expect(await postEvent(b, "hash-b", inbound("evt_same_id", "For B."))).toBe("queued");
  });

  it("deletes the conversation and its files", async () => {
    const stub = stubFor(`do-del-${Date.now()}`);
    await postEvent(stub, "hash-del", inbound("evt_do_del", "Hello."));
    const res = await stub.fetch("https://conversation/internal/delete", {
      method: "POST",
      body: JSON.stringify({ handleHash: "hash-del" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, filesDeleted: 0 });
    expect(await postEvent(stub, "hash-del", inbound("evt_do_del", "Hello."))).toBe("queued");
  });
});

describe("ChannelStateDO", () => {
  function stateStub(): DurableObjectStub {
    return workerEnv.CHANNEL_STATE.get(workerEnv.CHANNEL_STATE.idFromName(`state-${Date.now()}`));
  }

  it("checks and records spend", async () => {
    const stub = stateStub();
    const check = await stub.fetch("https://state/internal/spend-check", {
      method: "POST",
      body: JSON.stringify({ estimateUsd: 1 }),
    });
    expect(await check.json()).toEqual({ allowed: true, spentUsd: 0 });
    await stub.fetch("https://state/internal/spend-record", { method: "POST", body: JSON.stringify({ usd: 4.9 }) });
    const blocked = await stub.fetch("https://state/internal/spend-check", {
      method: "POST",
      body: JSON.stringify({ estimateUsd: 1 }),
    });
    expect(await blocked.json()).toEqual({ allowed: false, spentUsd: 4.9 });
  });

  it("holds the reconcile cursor", async () => {
    const stub = stateStub();
    expect(await (await stub.fetch("https://state/internal/cursor")).json()).toEqual({ cursor: null });
    await stub.fetch("https://state/internal/cursor", { method: "POST", body: JSON.stringify({ cursor: "c1" }) });
    expect(await (await stub.fetch("https://state/internal/cursor")).json()).toEqual({ cursor: "c1" });
  });
});
