import { describe, expect, it } from "vitest";
import { sendToChannels, signAgentSend } from "../src/channels-send.js";

// The engine signs agent sends exactly as Channels verifies them, pinned
// by the interop vector the Channels and agent suites share, and maps
// Channels' answers to sent, dropped, failed or retry.

const SEND = { handleHash: "ab".repeat(32), key: "reminder:t-1:0", text: "Hi.", generation: 1 };
const ENV = { MANO_CHANNELS_URL: "https://channels.test", MANO_AGENT_SECRET: "s" };

function answering(res: () => Response): typeof fetch {
  return (async () => res()) as unknown as typeof fetch;
}

describe("Channels agent-send client", () => {
  it("matches the shared interop vector", async () => {
    expect(await signAgentSend("interop-secret", "1761777000", '{"handleHash":"ab"}')).toBe(
      "042f17f9f8d6de11a23f0ca0c1ae55daba175a48af001583e909d62407e37096",
    );
  });

  it("maps Channels' answers", async () => {
    expect(await sendToChannels(ENV, SEND, answering(() => Response.json({ sent: true })))).toBe("sent");
    expect(await sendToChannels(ENV, SEND, answering(() => Response.json({ sent: false, reason: "opted_out" })))).toBe("dropped");
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
