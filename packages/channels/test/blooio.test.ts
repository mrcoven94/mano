import { describe, expect, it, vi } from "vitest";
import { BlooioChannel, parseBlooioEvent } from "../src/blooio.js";
import { ChannelFailed, ChannelRefused, ChannelUncertain } from "../src/channel.js";

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

  it("parses the 2026-10-01 webhook shape with no top-level id or channel_id", () => {
    // Shape from the Blooio docs 2026-10-01 message.received example: the
    // envelope carries type, api_version and created_at; data carries the
    // message with sender, recipient, channel_address, chat_id, message_id
    // and text, and no direction.
    const event = parseBlooioEvent({
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
    expect(event).toMatchObject({
      id: "message.received:msg_EXAMPLE",
      kind: "message.received",
      channelId: null,
      channelAddress: "+15557654321",
      chatId: "chat_EXAMPLE",
      messageId: "msg_EXAMPLE",
      handle: "+15551234567",
      direction: "inbound",
      text: "Hi Mano",
    });
  });

  it("still rejects an event with neither id nor message_id", () => {
    expect(parseBlooioEvent({ type: "message.received", data: { text: "Hi" } })).toBeNull();
  });

  it("marks unknown types ignored and rejects junk", () => {
    expect(parseBlooioEvent({ id: "evt_x", type: "safety.state_changed", data: {} })?.kind).toBe("ignored");
    expect(parseBlooioEvent({ nope: true })).toBeNull();
    expect(parseBlooioEvent("junk")).toBeNull();
  });

  it("keeps group metadata on the event", () => {
    const solo = parseBlooioEvent(webhookEnvelope())!;
    expect(solo.group).toBeNull();
    const grouped = parseBlooioEvent(webhookEnvelope({ group: { group_id: "grp_1", name: "Family" } }))!;
    expect(grouped.group).toEqual({ id: "grp_1", name: "Family" });
  });

  it("parses numeric and ISO timestamps, null when missing", () => {
    expect(parseBlooioEvent(webhookEnvelope())!.occurredAtMs).toBe(1_790_000_000_000);
    const seconds = parseBlooioEvent({
      id: "evt_s",
      type: "message.received",
      occurred_at: 1_790_000_000,
      data: { channel_id: CHANNEL_ID },
    })!;
    expect(seconds.occurredAtMs).toBe(1_790_000_000_000);
    const iso = parseBlooioEvent({
      id: "evt_iso",
      type: "message.received",
      occurred_at: "2026-10-28T12:00:00.000Z",
      data: { channel_id: CHANNEL_ID },
    })!;
    expect(iso.occurredAtMs).toBe(Date.parse("2026-10-28T12:00:00.000Z"));
    const missing = parseBlooioEvent({ id: "evt_none", type: "message.received", data: { channel_id: CHANNEL_ID } })!;
    expect(missing.occurredAtMs).toBeNull();
    const junk = parseBlooioEvent({
      id: "evt_junk",
      type: "message.received",
      occurred_at: "not a time",
      data: { channel_id: CHANNEL_ID },
    })!;
    expect(junk.occurredAtMs).toBeNull();
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

  it("fails terminally on a definitive 4xx without retrying", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(404, { code: "chat_not_found" }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    const err = await channel.send(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelFailed);
    expect((err as ChannelFailed).status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps a 408 uncertain and replays its key", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(408, { error: "timeout" }));
    const channel = new BlooioChannel({
      apiKey: API_KEY,
      channelId: CHANNEL_ID,
      fetchFn: fetchFn as typeof fetch,
      sleepFn: async () => {},
    });
    const err = await channel.send(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelUncertain);
    expect(fetchFn).toHaveBeenCalledTimes(3);
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

  it("hydrates a thin feed item into an answerable event", async () => {
    // Live shapes: the GET /events row carries no text or sender, and
    // GET /chats/{chatId}/messages/{messageId} returns the full v4
    // message object with channel_id, sender and text.
    const thin = parseBlooioEvent({
      id: "evt_feed_thin_1",
      type: "message.received",
      message_id: "AbC123xYz",
      chat_id: "chat_feed_aaa",
      channel_type: "blooio",
      occurred_at: 1793243237808,
      data: {},
    });
    expect(thin?.text).toBeNull();
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.blooio.com/v4/chats/chat_feed_aaa/messages/AbC123xYz");
      return jsonResponse(200, {
        data: {
          id: "AbC123xYz",
          chat_id: "chat_feed_aaa",
          channel_id: CHANNEL_ID,
          channel_type: "blooio",
          channel_address: "+18005550000",
          protocol: "imessage",
          direction: "inbound",
          sender: "+15551234567",
          recipient: "+18005550000",
          contact: { contact_id: "ct_1", identifier: "+15551234567", name: null },
          group: null,
          type: "text",
          text: "Do I qualify?",
          status: "received",
          attachments: [],
          created_at: 1793243237808,
        },
      });
    });
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as unknown as typeof fetch });
    const full = await channel.hydrateEvent(thin!);
    expect(full).toMatchObject({
      id: "evt_feed_thin_1",
      kind: "message.received",
      channelId: CHANNEL_ID,
      chatId: "chat_feed_aaa",
      messageId: "AbC123xYz",
      handle: "+15551234567",
      direction: "inbound",
      text: "Do I qualify?",
    });
  });

  it("hydration returns null for gone messages and non-receipts, and throws when transient", async () => {
    const thin = parseBlooioEvent({
      id: "evt_feed_thin_2",
      type: "message.received",
      message_id: "AbC999",
      chat_id: "chat_feed_aaa",
      channel_type: "blooio",
      occurred_at: 1793243237808,
      data: {},
    })!;
    for (const status of [404, 403]) {
      const fetchFn = vi.fn(async () => jsonResponse(status, { code: "gone" }));
      const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
      await expect(channel.hydrateEvent(thin)).resolves.toBeNull();
    }
    const failing = vi.fn(async () => jsonResponse(503, { error: "unavailable" }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: failing as typeof fetch });
    await expect(channel.hydrateEvent(thin)).rejects.toThrow();
    const receipt = parseBlooioEvent({
      id: "evt_feed_rcpt_1",
      type: "message.delivered",
      message_id: "msg_out_9",
      chat_id: "chat_feed_aaa",
      channel_type: "blooio",
      occurred_at: 1793243237900,
      data: {},
    })!;
    await expect(channel.hydrateEvent(receipt)).resolves.toBeNull();
  });
});

describe("Blooio native iMessage calls (LAP-636)", () => {
  it("adds a tapback on a message", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    await channel.react("chat_aaa", "msg_in_1", "love");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.blooio.com/v4/chats/chat_aaa/messages/msg_in_1/reactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reaction: "+love" });
  });

  it("adds an emoji reaction and sets the chat background as a multipart upload (LAP-508)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: { chat_id: "chat_aaa", background_id: "bg_1" } }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    await channel.react("chat_aaa", "msg_in_1", "🙏");
    await channel.react("chat_aaa", "msg_in_1", "👀");
    const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    await channel.setBackground("chat_aaa", image);
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ reaction: "+🙏" });
    expect(calls[1]![0]).toBe("https://api.blooio.com/v4/chats/chat_aaa/messages/msg_in_1/reactions");
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ reaction: "+👀" });
    expect(calls[2]![0]).toBe("https://api.blooio.com/v4/chats/chat_aaa/background");
    expect(calls[2]![1].method).toBe("PUT");
    const form = calls[2]![1].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("background") as File;
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
    expect(new Headers(calls[2]![1].headers).has("content-type")).toBe(false);
  });

  it("tells a known background failure from an uncertain one (PR 74 review, should 5)", async () => {
    const image = new Blob(["x"], { type: "image/png" });
    const refused = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: (async () => jsonResponse(400, { error: { code: "bad_image" } })) as typeof fetch });
    await expect(refused.setBackground("chat_aaa", image)).rejects.toBeInstanceOf(ChannelFailed);
    const limited = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: (async () => jsonResponse(429, {})) as typeof fetch });
    await expect(limited.setBackground("chat_aaa", image)).rejects.toBeInstanceOf(ChannelFailed);
    for (const status of [500, 502, 408]) {
      const unsure = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: (async () => jsonResponse(status, {})) as typeof fetch });
      await expect(unsure.setBackground("chat_aaa", image), String(status)).rejects.toBeInstanceOf(ChannelUncertain);
    }
    const dropped = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: (async () => { throw new TypeError("network"); }) as typeof fetch });
    await expect(dropped.setBackground("chat_aaa", image)).rejects.toBeInstanceOf(ChannelUncertain);
  });

  it("reads whether a chat has a background, to reconcile an uncertain upload", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: { chat_id: "chat_aaa", has_background: true, background_id: "bg_1" } }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    await expect(channel.hasBackground("chat_aaa")).resolves.toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.blooio.com/v4/chats/chat_aaa/background");
    expect(init.method ?? "GET").toBe("GET");
    const none = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: (async () => jsonResponse(200, { data: { has_background: false } })) as typeof fetch });
    await expect(none.hasBackground("chat_aaa")).resolves.toBe(false);
    const broken = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: (async () => jsonResponse(503, {})) as typeof fetch });
    await expect(broken.hasBackground("chat_aaa")).rejects.toThrow();
  });

  it("sends reply_to when a reply answers an earlier message", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201, { id: "msg_out_9", chat_id: "chat_aaa", status: "queued" }));
    const channel = new BlooioChannel({ apiKey: API_KEY, channelId: CHANNEL_ID, fetchFn: fetchFn as typeof fetch });
    await channel.send({ to: "+15550000001", chatId: "chat_aaa", text: "Friday, Nov 14.", idempotencyKey: "k1", replyTo: "msg_in_1" });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: "Friday, Nov 14.", reply_to: "msg_in_1" });
  });

  it("parses a message.reaction webhook into the reaction, its action and the reacted message", () => {
    const event = parseBlooioEvent({
      type: "message.reaction",
      created_at: Date.now(),
      data: { chat_id: "chat_aaa", message_id: "msg_out_3", reaction: "love", action: "add", original_text: "Synthetic text." },
    });
    expect(event?.kind).toBe("reaction");
    expect(event?.messageId).toBe("msg_out_3");
    expect(event?.reaction).toEqual({ value: "love", action: "add" });
  });
});
