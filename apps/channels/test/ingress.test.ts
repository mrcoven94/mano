import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSignatureHex } from "@mano/channels";
import { handleWebhook, reconcile, routeEvent } from "../src/index.js";
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
        channelType: "blooio", chatId: "chat_hook", messageId: "msg_in_1", handle: "+15550001001",
        direction: "inbound", text: "Hi", attachments: [], errorCode: null, errorMessage: null, occurredAtMs: 0,
      },
      env,
    );
    expect(routed).toBe("routed");
    expect(calls[0].name).toBe(expected);
    const skipped = await routeEvent(
      {
        id: "evt_r2", kind: "typing.started", rawType: "typing.started", channelId: CHANNEL_ID,
        channelType: "blooio", chatId: "chat_hook", messageId: null, handle: null,
        direction: null, text: null, attachments: [], errorCode: null, errorMessage: null, occurredAtMs: 0,
      },
      env,
    );
    expect(skipped).toBe("skipped");
  });
});

describe("reconcile", () => {
  it("enqueues missed events for our line and moves the cursor", async () => {
    const { parseBlooioEvent, RecordingChannel } = await import("@mano/channels");
    const sent: unknown[] = [];
    let cursor: string | null = null;
    const stub = {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/internal/cursor") && init?.method === "POST") {
          cursor = (JSON.parse(init.body as string) as { cursor: string | null }).cursor;
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response(JSON.stringify({ cursor }));
      },
    };
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
    expect(cursor).toBe("1");
  });

  it("dedupes a replayed page through the same event log", async () => {
    const { makeHarness, inboundEvent } = await import("./helpers.js");
    const h = makeHarness();
    const event = inboundEvent({ id: "evt_replay", text: "Hello." });
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("queued");
    expect(await h.runner.handleEvent(event, "reconcile")).toBe("duplicate");
  });
});
