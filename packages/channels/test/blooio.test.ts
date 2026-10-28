import { describe, expect, it, vi } from "vitest";
import { BlooioChannel, parseBlooioEvent } from "../src/blooio.js";
import { ChannelRefused, ChannelUncertain } from "../src/channel.js";

const CHANNEL_ID = "ch_test_line";
const API_KEY = "test-key-not-real";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function webhookEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "evt_webhook_1",
    type: "message.received",
    api_version: "2026-10-01",
    created_at: 1_790_000_000_000,
    organization_id: "org_test",
    data: {
      message_id: "msg_in_1",
      chat_id: "chat_aaa",
      channel_id: CHANNEL_ID,
      channel_type: "blooio",
      channel_address: "+18005550000",
      direction: "inbound",
      status: "received",
      protocol: "imessage",
      message_type: "text",
      text: "Hi Mano",
      sender: "+15551234567",
      recipient: "+18005550000",
      contact: { contact_id: "ct_1", identifier: "+15551234567", name: null },
      group: null,
      attachments: [],
      ...overrides,
    },
  };
}

describe("parseBlooioEvent", () => {
  it("parses the webhook envelope", () => {
    const event = parseBlooioEvent(webhookEnvelope());
    expect(event).toMatchObject({
      id: "evt_webhook_1",
      kind: "message.received",
      channelId: CHANNEL_ID,
      chatId: "chat_aaa",
      messageId: "msg_in_1",
      handle: "+15551234567",
      direction: "inbound",
      text: "Hi Mano",
    });
  });

  it("parses the GET /events feed shape", () => {
    const event = parseBlooioEvent({
      id: "evt_feed_1",
      type: "message.delivered",
      message_id: "msg_out_1",
      chat_id: "chat_aaa",
      channel_type: "blooio",
      occurred_at: 1_790_000_001_000,
      data: { channel_id: CHANNEL_ID, direction: "outbound", status: "delivered" },
    });
    expect(event).toMatchObject({
      id: "evt_feed_1",
      kind: "message.delivered",
      channelId: CHANNEL_ID,
      chatId: "chat_aaa",
      messageId: "msg_out_1",
    });
  });

  it("marks unknown types ignored and rejects junk", () => {
    expect(parseBlooioEvent({ id: "evt_x", type: "safety.state_changed", data: {} })?.kind).toBe("ignored");
    expect(parseBlooioEvent({ nope: true })).toBeNull();
    expect(parseBlooioEvent("junk")).toBeNull();
  });
});

describe("BlooioChannel.send", () => {
  const input = { to: "+15551234567", chatId: "chat_aaa", text: "Hello", idempotencyKey: "mano-key-1" };

  it("sends chat-scoped with the idempotency key", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { id: "msg_out_1", chat_id: "chat_aaa", status: "queued" }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    const result = await channel.send(input);
    expect(result).toEqual({ messageId: "msg_out_1", chatId: "chat_aaa", duplicate: false });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.blooio.com/v4/chats/chat_aaa/messages");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("mano-key-1");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello" });
  });

  it("sends channel-scoped when the chat is unknown", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { id: "msg_out_2", chat_id: "chat_bbb", status: "queued" }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    await channel.send({ ...input, chatId: null });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.blooio.com/v4/channels/${CHANNEL_ID}/messages`);
    expect(JSON.parse(init.body as string)).toEqual({ to: "+15551234567", text: "Hello" });
  });

  it("reports a replayed key as duplicate", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { id: "msg_out_1", chat_id: "chat_aaa", status: "sent" }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    expect((await channel.send(input)).duplicate).toBe(true);
  });

  it("records 403 and 429 as refusals without retrying", async () => {
    for (const [status, code] of [[403, "conversation_content_restricted"], [429, "conversation_streak_limit"]] as const) {
      const fetchFn = vi.fn(async () => jsonResponse(status, { code, message: "limited" }));
      const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
      const err = await channel.send(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChannelRefused);
      expect((err as ChannelRefused).code).toBe(code);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("retries 5xx under the same key, then reports uncertain", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, { error: "unavailable" }));
    const channel = new BlooioChannel({
      apiKey: API_KEY,
      channelId: CHANNEL_ID,
      fetchFn: fetchFn as typeof fetch,
      sleepFn: async () => {},
    });
    const err = await channel.send(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelUncertain);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const call of fetchFn.mock.calls) {
      expect(((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)["idempotency-key"]).toBe("mano-key-1");
    }
  });
});

describe("BlooioChannel reads", () => {
  it("looks messages up, with null on 404", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("msg_gone")
        ? new Response("{}", { status: 404 })
        : jsonResponse(200, { id: "msg_out_1", chat_id: "chat_aaa", status: "delivered", protocol: "imessage" }),
    );
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as unknown as typeof fetch });
    expect(await channel.lookupMessage("chat_aaa", "msg_out_1")).toMatchObject({ status: "delivered", protocol: "imessage" });
    expect(await channel.lookupMessage("chat_aaa", "msg_gone")).toBeNull();
  });

  it("pages the event feed", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: [webhookEnvelope()], next_cursor: null }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    const page = await channel.listEvents(null, 100);
    expect(page.events).toHaveLength(1);
    expect(page.events[0].id).toBe("evt_webhook_1");
    expect(page.nextCursor).toBeNull();
  });
});
