// The Mano channel: the one route Channels calls. Channels stays the
// transport (signature checks, dedupe, intro, STOP, consent, bubbles,
// spend); this route runs one synchronous turn (lib/turn.ts) and returns
// the reply text when it settles. Authenticated by HMAC over the raw body
// with the shared secret; the conversation address is the hashed handle,
// never a raw phone number. This file is only the Eve wiring: send the
// message into the person's session and read back its events.
import { defineChannel, POST } from "eve/channels";

import { engineFromEnv } from "../lib/engine.js";
import { settleStream, startIndexFor, type StreamEventLike } from "../lib/settle.js";
import { getKeyValue } from "../lib/storage.js";
import { handleTurn } from "../lib/turn.js";

export const TURN_PATH = "/channels/mano/turn";
// Channels' responder timeout sits above this, so a slow turn fails
// over to the fallback answer instead of hanging the conversation.
export const SETTLE_TIMEOUT_MS = 90_000;

export default defineChannel({
  routes: [
    POST(TURN_PATH, async (request, { from, resolveSession }) =>
      handleTurn(request, {
        secret: process.env.MANO_AGENT_SECRET,
        kv: await getKeyValue(),
        engine: engineFromEnv(),
        async runAgent({ handleHash, turnId, turnAtMs, message, context }) {
          const auth = {
            authenticator: "mano-channels",
            principalType: "user",
            principalId: handleHash,
            attributes: { turnId, turnAtMs: String(turnAtMs) },
          };
          // The tail index bounds the stream read to this turn's events. A
          // send that replaces a stranded session owns a fresh stream, so
          // the old tail is discarded and the read starts at zero.
          let tailBefore = -1;
          let existingId: string | null = null;
          try {
            const existing = await resolveSession(handleHash);
            if (existing) {
              existingId = existing.id;
              tailBefore = await existing.getStreamTailIndex();
            }
          } catch {
            // Stranded or gone: the send below starts fresh.
          }
          const session = await from(handleHash).send(message, { auth, context });
          const startIndex = startIndexFor(existingId, tailBefore, session.id);
          const stream = (await session.getEventStream({ startIndex })) as unknown as ReadableStream<StreamEventLike>;
          return settleStream(stream, { timeoutMs: SETTLE_TIMEOUT_MS });
        },
      }),
    ),
  ],
  events: {
    "turn.failed"(event, _channel, ctx) {
      console.warn(JSON.stringify({ type: "mano_turn_failed", session: ctx.session.id, terminal: event.terminal ?? false }));
    },
  },
});
