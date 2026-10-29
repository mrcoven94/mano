import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { hashHandle, parseBlooioEvent } from "@mano/channels";
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

  it("runs a second turn with the first turn read back from SQLite as history", async () => {
    const stub = stubFor(`do-history-${Date.now()}`);
    const runTurn = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await stub.fetch("https://conversation/internal/turn", {
        method: "POST",
        body: JSON.stringify({ handleHash: "hash-history" }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { result: string }).result;
    };
    expect(await postEvent(stub, "hash-history", inbound("evt_hist_1", "my food stamps are ending"))).toBe("queued");
    // The DO's own alarm may run the turn first; either way it ran.
    expect(["ran", "idle"]).toContain(await runTurn());
    expect(await postEvent(stub, "hash-history", inbound("evt_hist_2", "march 3"))).toBe("queued");
    expect(["ran", "idle"]).toContain(await runTurn());
    const recorded = (await (await stub.fetch("https://conversation/internal/standin")).json()) as {
      sends: Array<{ key: string; state: string }>;
      turn: number;
      pending: number;
    };
    expect(recorded.turn).toBe(2);
    expect(recorded.pending).toBe(0);
    expect(recorded.sends.length).toBe(3);
    expect(recorded.sends.every((s) => s.state === "sent")).toBe(true);
  }, 15000);

  it("answers a 2026-10-01 event with no id or channel_id", async () => {
    // Exact docs payload shape, parsed by the real parser, then run on
    // the real DO: dedupe key, sender handle and reply all derive from
    // the message_id-bearing envelope.
    const parsed = parseBlooioEvent({
      type: "message.received",
      api_version: "2026-10-01",
      // Live timestamp: the DO files anything older than its cutoff as stale.
      created_at: Date.now(),
      organization_id: "org_EXAMPLE",
      data: {
        kind: "received",
        message_type: "text",
        text: "Hi Mano",
        sender: "+15551234567",
        recipient: "+18005550000",
        channel_address: "+18005550000",
        chat_id: "chat_EXAMPLE_do",
        message_id: "msg_EXAMPLE_do",
        protocol: "imessage",
        attachments: [],
      },
    });
    expect(parsed?.id).toBe("message.received:msg_EXAMPLE_do");
    expect(parsed?.handle).toBe("+15551234567");
    if (!parsed?.handle) throw new Error("docs payload has no handle");
    const handleHash = await hashHandle(parsed.handle, workerEnv.MANO_HANDLE_PEPPER);
    const stub = stubFor(`do-docs-${Date.now()}`);
    expect(await postEvent(stub, handleHash, { ...parsed })).toBe("queued");
    expect(await postEvent(stub, handleHash, { ...parsed })).toBe("duplicate");
    await new Promise((r) => setTimeout(r, 3000));
    const turn = await stub.fetch("https://conversation/internal/turn", {
      method: "POST",
      body: JSON.stringify({ handleHash }),
    });
    expect(turn.status).toBe(200);
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

  it("dedupes a webhook+reconcile double delivery by message id", async () => {
    const stub = stubFor(`do-xpath-${Date.now()}`);
    const first = inbound("evt_webhook_x", "Hello.");
    const second = { ...inbound("evt_feed_y", "Hello."), messageId: first.messageId };
    expect(await postEvent(stub, "hash-xpath", first)).toBe("queued");
    expect(await postEvent(stub, "hash-xpath", second)).toBe("duplicate");
  });

  it("keeps conversations isolated per handle", async () => {
    const a = stubFor(`do-iso-a-${Date.now()}`);
    const b = stubFor(`do-iso-b-${Date.now()}`);
    expect(await postEvent(a, "hash-a", inbound("evt_same_id", "For A."))).toBe("queued");
    expect(await postEvent(b, "hash-b", inbound("evt_same_id", "For B."))).toBe("queued");
  });

  it("wipes pending, outbounds and approvals on delete", async () => {
    const stub = stubFor(`do-wipe-${Date.now()}`);
    expect(await postEvent(stub, "hash-wipe", inbound("evt_do_wipe_1", "Hi Mano"))).toBe("queued");
    await new Promise((r) => setTimeout(r, 3000));
    const turn = await stub.fetch("https://conversation/internal/turn", {
      method: "POST",
      body: JSON.stringify({ handleHash: "hash-wipe" }),
    });
    expect(turn.status).toBe(200);
    expect(await postEvent(stub, "hash-wipe", inbound("evt_do_wipe_2", "Still here."))).toBe("queued");
    const approval = await stub.fetch("https://conversation/internal/approval", {
      method: "POST",
      body: JSON.stringify({ handleHash: "hash-wipe", id: "apr_wipe", code: " ABC123 ", summary: "Test.", ttlMs: 60000 }),
    });
    expect(approval.status).toBe(200);
    const before = (await (await stub.fetch("https://conversation/internal/standin")).json()) as {
      sends: unknown[];
      pending: number;
      approvals: number;
    };
    expect(before.sends.length).toBeGreaterThan(0);
    expect(before.pending).toBe(1);
    expect(before.approvals).toBe(1);
    const res = await stub.fetch("https://conversation/internal/delete", {
      method: "POST",
      body: JSON.stringify({ handleHash: "hash-wipe" }),
    });
    expect(res.status).toBe(200);
    const after = (await (await stub.fetch("https://conversation/internal/standin")).json()) as {
      sends: unknown[];
      pending: number;
      approvals: number;
    };
    expect(after).toMatchObject({ sends: [], pending: 0, approvals: 0 });
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

  it("reserves worst-case spend and settles actual", async () => {
    const stub = stateStub();
    const first = await stub.fetch("https://state/internal/spend-reserve", {
      method: "POST",
      body: JSON.stringify({ key: "a:1", worstUsd: 4 }),
    });
    expect(await first.json()).toEqual({ allowed: true, spentUsd: 0 });
    const blocked = await stub.fetch("https://state/internal/spend-reserve", {
      method: "POST",
      body: JSON.stringify({ key: "b:1", worstUsd: 2 }),
    });
    expect(await blocked.json()).toEqual({ allowed: false, spentUsd: 0 });
    await stub.fetch("https://state/internal/spend-settle", {
      method: "POST",
      body: JSON.stringify({ key: "a:1", actualUsd: 1.5 }),
    });
    const freed = await stub.fetch("https://state/internal/spend-reserve", {
      method: "POST",
      body: JSON.stringify({ key: "b:1", worstUsd: 2 }),
    });
    expect(await freed.json()).toEqual({ allowed: true, spentUsd: 1.5 });
  });

  it("holds the reconcile cursor", async () => {
    const stub = stateStub();
    expect(await (await stub.fetch("https://state/internal/cursor")).json()).toEqual({ cursor: null });
    await stub.fetch("https://state/internal/cursor", { method: "POST", body: JSON.stringify({ cursor: "c1" }) });
    expect(await (await stub.fetch("https://state/internal/cursor")).json()).toEqual({ cursor: "c1" });
  });
});
