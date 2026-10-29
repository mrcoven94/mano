// Delivers an agent-started text (a due reminder) through Channels'
// internal agent-send route over HTTPS. The request is signed the way
// Channels verifies agent requests: hex HMAC-SHA256 with MANO_AGENT_SECRET
// over `<unix seconds>.<raw body>`, in x-mano-timestamp and
// x-mano-signature. Channels dedupes on `key` within the conversation
// generation, so resending the same key after an uncertain result never
// sends twice.
import { boundFetch } from "./fetch.js";

export interface ChannelsSendEnv {
  MANO_CHANNELS_URL?: string;
  MANO_AGENT_SECRET?: string;
}

export interface AgentSend {
  handleHash: string;
  key: string;
  text: string;
  generation: number;
}

// sent: delivered. dropped: Channels refused it for good (unknown or
// closed conversation, opted out, generation moved on). failed: the
// request itself is wrong and never will succeed. retry: budget, outage,
// timeout or config not yet set; try again later under the same key.
export type SendOutcome = "sent" | "dropped" | "failed" | "retry";

export async function signAgentSend(secret: string, timestampSeconds: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSeconds}.${rawBody}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sendToChannels(
  env: ChannelsSendEnv,
  send: AgentSend,
  fetchFn: typeof fetch = boundFetch,
  nowMs = Date.now(),
): Promise<SendOutcome> {
  if (!env.MANO_CHANNELS_URL || !env.MANO_AGENT_SECRET) return "retry";
  const raw = JSON.stringify({ handleHash: send.handleHash, key: send.key, text: send.text, generation: send.generation });
  const timestamp = String(Math.floor(nowMs / 1000));
  let res: Response;
  try {
    res = await fetchFn(new URL("/internal/agent-send", env.MANO_CHANNELS_URL).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mano-timestamp": timestamp,
        "x-mano-signature": await signAgentSend(env.MANO_AGENT_SECRET, timestamp, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return "retry";
  }
  if (res.status === 200) {
    const body = (await res.json().catch(() => null)) as { sent?: unknown } | null;
    return body?.sent === true ? "sent" : "dropped";
  }
  if (res.status === 400) return "failed";
  return "retry";
}
