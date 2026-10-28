import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { computeSignatureHex } from "@mano/channels";
import type { Env } from "../src/env.js";

const workerEnv = env as unknown as Env;

function envelope(channelId: string): string {
  return JSON.stringify({
    id: "evt_worker_1",
    type: "message.received",
    api_version: "2026-10-01",
    created_at: Date.now(),
    organization_id: "org_test",
    data: {
      message_id: "msg_in_1",
      chat_id: "chat_worker",
      channel_id: channelId,
      channel_type: "blooio",
      direction: "inbound",
      text: "Hi Mano",
      sender: "+15550001001",
      recipient: "+18005550000",
      attachments: [],
    },
  });
}

describe("worker ingress", () => {
  it("answers ok on /health and reveals nothing else", async () => {
    const res = await SELF.fetch("https://worker/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a bad signature with 401", async () => {
    const res = await SELF.fetch("https://worker/webhooks/blooio", {
      method: "POST",
      headers: { "x-blooio-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
      body: envelope("ch_test_line"),
    });
    expect(res.status).toBe(401);
  });

  it("ignores another line's events with 202", async () => {
    const t = Math.floor(Date.now() / 1000);
    const body = envelope("ch_someone_else");
    const v1 = await computeSignatureHex(workerEnv.BLOOIO_WEBHOOK_SECRET, String(t), body);
    const res = await SELF.fetch("https://worker/webhooks/blooio", {
      method: "POST",
      headers: { "x-blooio-signature": `t=${t},v1=${v1}` },
      body,
    });
    expect(res.status).toBe(202);
  });
});
