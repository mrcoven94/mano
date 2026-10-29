// Delivers agent-started texts (reminders, nudges) through Channels'
// internal route. Channels still applies consent, STOP, and spend;
// this call only hands it the hashed handle, the text, and an
// idempotency key. Signed with the same shared secret as turns.
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody } from "./auth.js";

export const AGENT_SEND_PATH = "/internal/agent-send";

export interface DeliverOptions {
  channelsUrl: string;
  secret: string;
  handleHash: string;
  text: string;
  key: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class DeliverFailed extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Channels delivery failed: ${status}`);
    this.name = "DeliverFailed";
    this.status = status;
  }
}

export async function deliverToChannels(opts: DeliverOptions): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ handleHash: opts.handleHash, text: opts.text, key: opts.key });
  const res = await (opts.fetchFn ?? fetch)(`${opts.channelsUrl.replace(/\/$/, "")}${AGENT_SEND_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signBody(opts.secret, timestamp, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new DeliverFailed(res.status);
  await res.body?.cancel().catch(() => undefined);
}
