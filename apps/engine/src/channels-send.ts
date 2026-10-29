// Delivers an engine-started text (a due reminder) through Channels'
// POST /internal/agent-send over HTTPS, signed with MANO_ENGINE_SEND_SECRET
// as packages/protocol engine-send.ts defines: method, path, timestamp and
// body, in x-mano-engine-timestamp and x-mano-engine-signature. Channels
// dedupes on `key` within the conversation generation, so resending the
// same key after an uncertain result never sends twice.
import { ENGINE_SEND_SIGNATURE_HEADER, ENGINE_SEND_TIMESTAMP_HEADER, signEngineSend } from "@mano/protocol";
import { boundFetch } from "./fetch.js";

const SEND_PATH = "/internal/agent-send";

export interface ChannelsSendEnv {
  MANO_CHANNELS_URL?: string;
  MANO_ENGINE_SEND_SECRET?: string;
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

export async function sendToChannels(
  env: ChannelsSendEnv,
  send: AgentSend,
  fetchFn: typeof fetch = boundFetch,
  nowMs = Date.now(),
): Promise<SendOutcome> {
  if (!env.MANO_CHANNELS_URL || !env.MANO_ENGINE_SEND_SECRET) return "retry";
  const raw = JSON.stringify({ handleHash: send.handleHash, key: send.key, text: send.text, generation: send.generation });
  const timestamp = String(Math.floor(nowMs / 1000));
  let res: Response;
  try {
    res = await fetchFn(new URL(SEND_PATH, env.MANO_CHANNELS_URL).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ENGINE_SEND_TIMESTAMP_HEADER]: timestamp,
        [ENGINE_SEND_SIGNATURE_HEADER]: await signEngineSend(env.MANO_ENGINE_SEND_SECRET, "POST", SEND_PATH, timestamp, raw),
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
