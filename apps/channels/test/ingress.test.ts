import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSignatureHex, type NormalizedEvent } from "@mano/channels";
import worker, { handleWebhook, reconcile, routeEvent } from "../src/index.js";
import type { Env } from "../src/env.js";

const SECRET = "test-webhook-secret-not-real";
const CHANNEL_ID = "ch_test_line";

function envelope(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_hook_1",
    type: "message.received",
    api_version: "2026-10-01",
    created_at: 1_790_000_000_000,
    organization_id: "org_test",
    data: {
      message_id: "msg_in_1",
      chat_id: "chat_hook",
      channel_id: CHANNEL_ID,
      channel_type: "blooio",
      direction: "inbound",
      text: "Hi Mano",
      sender: "+15550001001",
      recipient: "+18005550000",
      attachments: [],
      ...data,
    },
    ...overrides,
  });
}

async function signedRequest(body: string, t: number): Promise<Request> {
  const v1 = await computeSignatureHex(SECRET, String(t), body);
  return new Request("https://channels.example.test/webhooks/blooio", {
    method: "POST",
    headers: { "x-blooio-signature": `t=${t},v1=${v1}` },
    body,
  });
}

function hookEnv(sent: unknown[]): Env {
  return {
    CONVERSATION: null as unknown as Env["CONVERSATION"],
    CHANNEL_STATE: null as unknown as Env["CHANNEL_STATE"],
    EVENTS: { send: async (msg: unknown) => void sent.push(msg) } as unknown as Env["EVENTS"],
    FILES: null as unknown as Env["FILES"],
    BLOOIO_API_KEY: "",
    BLOOIO_CHANNEL_ID: CHANNEL_ID,
    BLOOIO_WEBHOOK_SECRET: SECRET,
    MANO_HANDLE_PEPPER: "test-pepper-not-real",
    ENCRYPTION_KEK_B64: "",
  };
}

describe("webhook ingress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifies, scopes and queues", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const res = await handleWebhook(await signedRequest(envelope(), now), hookEnv(sent));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "evt_hook_1", kind: "message.received", handle: "+15550001001" });
  });

  it("accepts multibyte bodies verified over raw bytes", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const body = envelope({}, { text: "Héllo wörld ✓" });
    const res = await handleWebhook(await signedRequest(body, now), hookEnv(sent));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "evt_hook_1", text: "Héllo wörld ✓" });
  });

  it("rejects bad and stale signatures", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const bad = new Request("https://channels.example.test/webhooks/blooio", {
      method: "POST",
      headers: { "x-blooio-signature": `t=${now},v1=${"0".repeat(64)}` },
      body: envelope(),
    });
    expect((await handleWebhook(bad, hookEnv(sent))).status).toBe(401);
    expect((await handleWebhook(await signedRequest(envelope(), now - 600), hookEnv(sent))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("ignores events for another line without queueing", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const body = envelope({}, { channel_id: "ch_someone_else" });
    const res = await handleWebhook(await signedRequest(body, now), hookEnv(sent));
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it("accepts the 2026-10-01 shape with no id or channel_id", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "message.received",
      api_version: "2026-10-01",
      created_at: 1730000000000,
      organization_id: "org_EXAMPLE",
      data: {
        kind: "received",
        message_type: "text",
        text: "Hi Mano",
        sender: "+15551234567",
        recipient: "+15557654321",
        channel_address: "+15557654321",
        chat_id: "chat_EXAMPLE",
        message_id: "msg_EXAMPLE",
        protocol: "imessage",
        attachments: [],
      },
    });
    const res = await handleWebhook(
      await signedRequest(body, now),
      { ...hookEnv(sent), MANO_TEXT_NUMBER: "+15557654321" },
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: "message.received:msg_EXAMPLE",
      handle: "+15551234567",
      direction: "inbound",
      text: "Hi Mano",
    });
  });

  it("ignores an event whose address names another line", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const body = envelope({}, { channel_id: undefined, channel_address: "+15550009999" });
    const res = await handleWebhook(
      await signedRequest(body, now),
      { ...hookEnv(sent), MANO_TEXT_NUMBER: "+18005550000" },
    );
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it("skips the address check when our number is not configured", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const body = envelope({}, { channel_id: undefined, channel_address: "+15550009999" });
    const res = await handleWebhook(await signedRequest(body, now), hookEnv(sent));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("fails closed when the webhook secret is not set", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const res = await handleWebhook(await signedRequest(envelope(), now), { ...hookEnv(sent), BLOOIO_WEBHOOK_SECRET: "" });
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("ignores non-events and rejects bad JSON", async () => {
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    expect((await handleWebhook(await signedRequest(JSON.stringify({ hello: 1 }), now), hookEnv(sent))).status).toBe(202);
    expect((await handleWebhook(await signedRequest("not json", now), hookEnv(sent))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("logs no message text on the way in", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    const sent: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const body = envelope({}, { text: "SENTINEL-INBOUND-4" });
    expect((await handleWebhook(await signedRequest(body, now), hookEnv(sent))).status).toBe(200);
    expect(lines.join("\n")).not.toContain("SENTINEL-INBOUND-4");
    expect(lines.join("\n")).not.toContain("+15550001001");
    const enqueued = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.eventId === "evt_hook_1");
    expect(enqueued).toMatchObject({ event: "webhook_enqueued", eventId: "evt_hook_1" });
    expect(enqueued?.chat).toMatch(/^[0-9a-f]{64}$/);
    expect(enqueued?.chat).not.toBe("chat_hook");
  });

  it("drops dead letters after recording their ID", async () => {
    const { handleDeadLetters } = await import("../src/index.js");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    let acked = 0;
    handleDeadLetters({
      queue: "mano-channel-events-dlq",
      messages: [
        {
          body: { id: "evt_dlq_1", rawType: "message.received", text: "SENTINEL-DLQ-8", handle: "+15550001001" },
          ack: () => void (acked += 1),
          retry: () => {},
        },
      ],
    } as unknown as MessageBatch<unknown>);
    expect(acked).toBe(1);
    expect(lines.join("\n")).toContain("evt_dlq_1");
    expect(lines.join("\n")).not.toContain("SENTINEL-DLQ-8");
    expect(lines.join("\n")).not.toContain("+15550001001");
  });
});

describe("routeEvent", () => {
  it("routes by hashed handle and skips the ephemeral", async () => {
    const calls: Array<{ name: string; body: unknown }> = [];
    const stub = { fetch: async (_url: string, init: RequestInit) => new Response(JSON.stringify({ result: "queued" }), { status: 200, headers: { "content-type": "application/json" } }) };
    const ns = {
      idFromName: (name: string) => {
        calls.push({ name, body: null });
        return { name };
      },
      get: () => stub,
    };
    const env = { ...hookEnv([]), CONVERSATION: ns } as unknown as Env;
    const { hashHandle } = await import("@mano/channels");
    const expected = await hashHandle("+15550001001", "test-pepper-not-real");
    const routed = await routeEvent(
      {
        id: "evt_r1", kind: "message.received", rawType: "message.received", channelId: CHANNEL_ID,
        channelType: "blooio",
        channelAddress: null, chatId: "chat_hook", messageId: "msg_in_1", group: null, handle: "+15550001001",
        direction: "inbound", text: "Hi", attachments: [], errorCode: null, errorMessage: null, occurredAtMs: 0,
      },
      env,
    );
    expect(routed).toBe("routed");
    expect(calls[0].name).toBe(expected);
    const skipped = await routeEvent(
      {
        id: "evt_r2", kind: "typing.started", rawType: "typing.started", channelId: CHANNEL_ID,
        channelType: "blooio",
        channelAddress: null, chatId: "chat_hook", messageId: null, group: null, handle: null,
        direction: null, text: null, attachments: [], errorCode: null, errorMessage: null, occurredAtMs: 0,
      },
      env,
    );
    expect(skipped).toBe("skipped");
  });

  it("routes a handle-less receipt by its chat", async () => {
    const routedTo: string[] = [];
    const convStub = { fetch: async () => new Response(JSON.stringify({ result: "recorded" }), { status: 200 }) };
    const convNs = {
      idFromName: (name: string) => {
        routedTo.push(name);
        return { name };
      },
      get: () => convStub,
    };
    const routes = new Map([["chat-hash-hook", "hash-owner"]]);
    const stateStub = {
      fetch: async (url: string) => {
        const chat = new URL(url).searchParams.get("chat") ?? "";
        return new Response(JSON.stringify({ handleHash: routes.get(chat) ?? null }));
      },
    };
    const env = {
      ...hookEnv([]),
      CONVERSATION: convNs,
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stateStub },
    } as unknown as Env;
    const { hashChatId } = await import("@mano/channels");
    routes.set(await hashChatId("chat_hook", "test-pepper-not-real"), "hash-owner");
    const receipt: NormalizedEvent = {
      id: "evt_feed_rcpt", kind: "message.delivered", rawType: "message.delivered", channelId: CHANNEL_ID,
      channelType: "blooio",
      channelAddress: null, chatId: "chat_hook", messageId: "msg_out_1", group: null, handle: null,
      direction: "outbound", text: null, attachments: [], errorCode: null, errorMessage: null, occurredAtMs: 1_790_000_001_000,
    };
    expect(await routeEvent({ ...receipt }, env)).toBe("routed");
    expect(routedTo).toEqual(["hash-owner"]);
    routes.clear();
    expect(await routeEvent({ ...receipt, id: "evt_feed_rcpt2" }, env)).toBe("skipped");
  });
});

describe("reconcile", () => {
  function stateStub() {
    let cursor: string | null = null;
    const seen = new Set<string>();
    return {
      get cursor() {
        return cursor;
      },
      fetch: async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(init.body as string) as { cursor?: string | null; ids?: string[] }) : {};
        if (url.endsWith("/internal/cursor") && init?.method === "POST") {
          cursor = body.cursor ?? null;
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.endsWith("/internal/seen-check")) {
          const ids = body.ids ?? [];
          return new Response(JSON.stringify({ unseen: ids.filter((id) => !seen.has(id)) }));
        }
        if (url.endsWith("/internal/seen-note")) {
          for (const id of body.ids ?? []) seen.add(id);
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response(JSON.stringify({ cursor }));
      },
    };
  }

  it("enqueues missed events for our line and moves the cursor", async () => {
    const { parseBlooioEvent, RecordingChannel } = await import("@mano/channels");
    const sent: unknown[] = [];
    const stub = stateStub();
    const ours = parseBlooioEvent(JSON.parse(envelope()))!;
    const otherLine = { ...ours, id: "evt_other", channelId: "ch_someone_else" };
    const feed = new RecordingChannel();
    feed.feedPages = [[ours], [otherLine]];
    const env = {
      ...hookEnv(sent),
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stub },
    } as unknown as Env;
    const result = await reconcile(env, feed);
    expect(result).toEqual({ pages: 2, enqueued: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "evt_hook_1" });
    expect(stub.cursor).toBe("1");
  });

  it("does not requeue a page the feed serves again", async () => {
    const { parseBlooioEvent, RecordingChannel } = await import("@mano/channels");
    const sent: unknown[] = [];
    const stub = stateStub();
    const ours = parseBlooioEvent(JSON.parse(envelope()))!;
    const feed = new RecordingChannel();
    feed.feedPages = [[ours]];
    const env = {
      ...hookEnv(sent),
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stub },
    } as unknown as Env;
    expect(await reconcile(env, feed)).toEqual({ pages: 1, enqueued: 1 });
    expect(await reconcile(env, feed)).toEqual({ pages: 1, enqueued: 0 });
    expect(sent).toHaveLength(1);
  });

  it("dedupes a replayed page through the same event log", async () => {
    const { makeHarness, inboundEvent } = await import("./helpers.js");
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_replay", text: "Hello.", occurredAtMs: h.now });
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("queued");
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("duplicate");
  });

  it("hydrates thin feed rows and queues only our line", async () => {
    const { parseBlooioEvent, RecordingChannel } = await import("@mano/channels");
    const { inboundEvent } = await import("./helpers.js");
    const sent: unknown[] = [];
    const stub = stateStub();
    // The live GET /events row: ids and timestamp only, empty data.
    const thin = (id: string, messageId: string) =>
      parseBlooioEvent({
        id,
        type: "message.received",
        message_id: messageId,
        chat_id: "chat_feed_aaa",
        channel_type: "blooio",
        occurred_at: 1793243237808,
        data: {},
      })!;
    const feed = new RecordingChannel();
    feed.feedPages = [[thin("evt_feed_a", "msg_a"), thin("evt_feed_b", "msg_b"), thin("evt_feed_gone", "msg_gone")]];
    feed.hydrated.set(
      "msg_a",
      inboundEvent({ id: "evt_feed_a", chatId: "chat_feed_aaa", messageId: "msg_a", channelId: "ch_test_line", text: "Hydrated." }),
    );
    feed.hydrated.set(
      "msg_b",
      inboundEvent({ id: "evt_feed_b", chatId: "chat_feed_aaa", messageId: "msg_b", channelId: "ch_someone_else", text: "Theirs." }),
    );
    const env = {
      ...hookEnv(sent),
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stub },
    } as unknown as Env;
    expect(await reconcile(env, feed)).toEqual({ pages: 1, enqueued: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "evt_feed_a", text: "Hydrated.", handle: "+15550001001" });
    expect(feed.hydrateCalls).toEqual(["msg_a", "msg_b", "msg_gone"]);
    // Gone and other-line rows are marked seen: the next run skips them.
    expect(await reconcile(env, feed)).toEqual({ pages: 1, enqueued: 0 });
    expect(sent).toHaveLength(1);
  });

  it("answers a webhook+reconcile double delivery once", async () => {
    const { makeHarness, inboundEvent } = await import("./helpers.js");
    const h = makeHarness();
    const sameMessage = { messageId: "msg_both_paths", text: "Hello.", occurredAtMs: h.now };
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_webhook_x", ...sameMessage }), "webhook")).toBe("queued");
    expect(await h.runner.handleEvent(inboundEvent({ id: "evt_feed_y", ...sameMessage }), "reconcile")).toBe("duplicate");
  });

  it("pauses a page on transient hydrate failure and resumes next run", async () => {
    const { parseBlooioEvent, RecordingChannel } = await import("@mano/channels");
    const { inboundEvent } = await import("./helpers.js");
    const sent: unknown[] = [];
    const stub = stateStub();
    const thin = (id: string, messageId: string) =>
      parseBlooioEvent({
        id,
        type: "message.received",
        message_id: messageId,
        chat_id: "chat_feed_aaa",
        channel_type: "blooio",
        occurred_at: 1793243237808,
        data: {},
      })!;
    const feed = new RecordingChannel();
    feed.feedPages = [[thin("evt_p_a", "msg_p_a"), thin("evt_p_b", "msg_p_b")], [thin("evt_p_c", "msg_p_c")]];
    feed.hydrated.set("msg_p_a", inboundEvent({ id: "evt_p_a", messageId: "msg_p_a", channelId: "ch_test_line", text: "First." }));
    feed.hydrated.set("msg_p_b", inboundEvent({ id: "evt_p_b", messageId: "msg_p_b", channelId: "ch_test_line", text: "Second." }));
    feed.hydrated.set("msg_p_c", inboundEvent({ id: "evt_p_c", messageId: "msg_p_c", channelId: "ch_test_line", text: "Third." }));
    feed.hydrateErrors.set("msg_p_b", new Error("fetch failed"));
    const env = {
      ...hookEnv(sent),
      CHANNEL_STATE: { idFromName: (name: string) => ({ name }), get: () => stub },
    } as unknown as Env;
    expect(await reconcile(env, feed)).toEqual({ pages: 1, enqueued: 1 });
    expect(stub.cursor).toBeNull();
    feed.hydrateErrors.delete("msg_p_b");
    expect(await reconcile(env, feed)).toEqual({ pages: 2, enqueued: 2 });
    expect(stub.cursor).toBe("1");
    expect(sent).toHaveLength(3);
  });

  it("logs a failing cron tick instead of throwing", async () => {
    await expect(worker.scheduled({} as never, hookEnv([]))).resolves.toBeUndefined();
  });
});
