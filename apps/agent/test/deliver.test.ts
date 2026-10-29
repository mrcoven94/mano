import { describe, expect, it } from "vitest";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../agent/lib/auth.js";
import { DeliverFailed, deliverToChannels } from "../agent/lib/deliver.js";

describe("channels delivery", () => {
  it("posts the signed body to the internal route", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await deliverToChannels({
      channelsUrl: "https://channels.example/",
      secret: "s",
      handleHash: "h",
      text: "Reminder: call",
      key: "rem_1",
      fetchFn,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://channels.example/internal/agent-send");
    expect(seen[0].headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(seen[0].headers[SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(seen[0].body)).toEqual({ handleHash: "h", text: "Reminder: call", key: "rem_1" });
  });

  it("throws a status-only error on failure", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const err = await deliverToChannels({
      channelsUrl: "https://x",
      secret: "s",
      handleHash: "h",
      text: "t",
      key: "k",
      fetchFn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliverFailed);
    expect((err as DeliverFailed).status).toBe(500);
  });
});
