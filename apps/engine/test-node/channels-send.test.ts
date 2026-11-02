import { describe, expect, it } from "vitest";
import { ENGINE_SEND_SIGNATURE_HEADER, ENGINE_SEND_TIMESTAMP_HEADER, verifyEngineSend } from "@mano/protocol";
import { sendToChannels } from "../src/channels-send.js";

// The engine signs sends to Channels with MANO_ENGINE_SEND_SECRET over
// method, path, timestamp and body, as the protocol's verifier checks,
// and maps Channels' answers to sent, dropped, failed or retry.

const SEND = { handleHash: "ab".repeat(32), key: "reminder:t-1:0", text: "Hi.", generation: 1 };
const ENV = { MANO_CHANNELS_URL: "https://channels.test", MANO_ENGINE_SEND_SECRET: "engine-send-secret" };

function answering(res: () => Response): typeof fetch {
  return (async () => res()) as unknown as typeof fetch;
}

describe("Channels agent-send client", () => {
  it("signs what the receiver verifies, and nothing the agent's secret could forge", async () => {
    let seen: { url: string; headers: Headers; body: string } | null = null;
    const capture = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: String(init.body) };
      return Response.json({ sent: true });
    }) as unknown as typeof fetch;
    const now = Date.now();
    expect(await sendToChannels(ENV, SEND, capture, now)).toBe("sent");
    const s = seen!;
    expect(s.url).toBe("https://channels.test/internal/agent-send");
    const request = {
      method: "POST",
      path: new URL(s.url).pathname,
      timestamp: s.headers.get(ENGINE_SEND_TIMESTAMP_HEADER),
      signature: s.headers.get(ENGINE_SEND_SIGNATURE_HEADER),
      body: s.body,
    };
    expect(await verifyEngineSend("engine-send-secret", request, Math.floor(now / 1000))).toEqual({ ok: true });
    expect((await verifyEngineSend("the-agents-secret", request, Math.floor(now / 1000))).ok).toBe(false);
    expect(s.headers.get("x-mano-signature")).toBeNull();
  });

  it("maps Channels' answers", async () => {
    expect(await sendToChannels(ENV, SEND, answering(() => Response.json({ sent: true })))).toBe("sent");
    expect(await sendToChannels(ENV, SEND, answering(() => Response.json({ sent: false, reason: "opted_out" })))).toBe("dropped");
    // Only an explicit, well-formed answer is terminal. Anything Channels
    // did not clearly say stays uncertain and retries under the same key.
    const unclear: [string, () => Response][] = [
      ["truncated JSON", () => new Response('{"sent":fal', { status: 200 })],
      ["an empty object", () => Response.json({})],
      ["sent:false with no reason", () => Response.json({ sent: false })],
      ["sent as a string", () => Response.json({ sent: "true" })],
      ["an array", () => Response.json([true])],
      ["an empty body", () => new Response("", { status: 200 })],
      [
        "a body that fails to read",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 200 },
          ),
      ],
    ];
    for (const [label, res] of unclear) {
      expect(await sendToChannels(ENV, SEND, answering(res)), label).toBe("retry");
    }
    expect(await sendToChannels(ENV, SEND, answering(() => new Response("bad", { status: 400 })))).toBe("failed");
    for (const status of [401, 429, 500, 503]) {
      expect(await sendToChannels(ENV, SEND, answering(() => new Response("", { status })))).toBe("retry");
    }
    const down = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await sendToChannels(ENV, SEND, down)).toBe("retry");
    expect(await sendToChannels({}, SEND, answering(() => Response.json({ sent: true })))).toBe("retry");
  });
});
