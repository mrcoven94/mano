// The Mano channel: the one route Channels calls. Channels stays the
// transport (signature checks, dedupe, intro, STOP, consent, bubbles,
// spend); this route runs one synchronous turn and returns the reply
// text when the turn settles, or the pending yes-or-no question when
// the turn parks on one. Authenticated by HMAC over the raw body with
// the shared secret; the conversation address is the hashed handle,
// never a raw phone number.
import { defineChannel, POST } from "eve/channels";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "../lib/auth.js";
import { CRISIS_LINE, detectCrisis } from "../lib/crisis.js";
import { SettleTimeout, settleStream, startIndexFor, type StreamEventLike } from "../lib/settle.js";

export const TURN_PATH = "/channels/mano/turn";
// Channels' responder timeout sits above this, so a slow turn fails
// over to the fallback answer instead of hanging the conversation.
export const SETTLE_TIMEOUT_MS = 90_000;
const MAX_TEXTS = 10;
const MAX_TEXT_CHARS = 4000;

interface TurnBody {
  handleHash: string;
  texts: string[];
  attachmentCount: number;
}

function parseBody(value: unknown): TurnBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.handleHash !== "string" || !/^[0-9a-f]{16,128}$/.test(body.handleHash)) return null;
  if (!Array.isArray(body.texts)) return null;
  const texts = body.texts.filter((t): t is string => typeof t === "string").slice(0, MAX_TEXTS);
  if (texts.some((t) => t.length > MAX_TEXT_CHARS)) return null;
  const attachmentCount =
    typeof body.attachmentCount === "number" && Number.isInteger(body.attachmentCount) && body.attachmentCount >= 0
      ? Math.min(body.attachmentCount, 10)
      : 0;
  if (texts.length === 0 && attachmentCount === 0) return null;
  return { handleHash: body.handleHash, texts, attachmentCount };
}

function turnText(body: TurnBody): string {
  const parts = [...body.texts];
  if (body.attachmentCount > 0) {
    parts.push(
      `(The person also sent ${body.attachmentCount} photo${body.attachmentCount === 1 ? "" : "s"}; they are saved and will be read separately. Acknowledge briefly if you mention them.)`,
    );
  }
  return parts.join("\n");
}

export default defineChannel({
  routes: [
    POST(TURN_PATH, async (request, { from, resolveSession }) => {
      const receivedMs = Date.now();
      const raw = new Uint8Array(await request.arrayBuffer());
      const check = verifyRequest(
        process.env.MANO_AGENT_SECRET,
        request.headers.get(TIMESTAMP_HEADER),
        request.headers.get(SIGNATURE_HEADER),
        raw,
      );
      if (!check.ok) {
        console.warn(JSON.stringify({ type: "mano_turn_rejected", reason: check.reason }));
        return new Response("Unauthorized.", { status: 401 });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return new Response("Bad JSON.", { status: 400 });
      }
      const body = parseBody(parsed);
      if (!body) return new Response("Bad turn.", { status: 400 });

      const crisis = body.texts.some(detectCrisis);
      const message = turnText(body);
      const context = crisis ? [CRISIS_LINE] : [];
      const auth = {
        authenticator: "mano-channels",
        principalType: "user",
        principalId: body.handleHash,
        attributes: {},
      };

      try {
        // The tail index bounds the stream read to this turn's events. A
        // send that replaces a stranded session owns a fresh stream, so
        // the old tail is discarded and the read starts at zero.
        let tailBefore = -1;
        let existingId: string | null = null;
        try {
          const existing = await resolveSession(body.handleHash);
          if (existing) {
            existingId = existing.id;
            tailBefore = await existing.getStreamTailIndex();
          }
        } catch {
          // Stranded or gone: the send below starts fresh.
        }
        const session = await from(body.handleHash).send(message, { auth, context });
        const startIndex = startIndexFor(existingId, tailBefore, session.id);
        const stream = (await session.getEventStream({ startIndex })) as unknown as ReadableStream<StreamEventLike>;
        const settled = await settleStream(stream, { timeoutMs: SETTLE_TIMEOUT_MS });
        console.log(
          JSON.stringify({
            type: "mano_turn",
            handle: body.handleHash,
            status: settled.status,
            reason: settled.reason,
            latencyMs: Date.now() - receivedMs,
          }),
        );
        if (settled.status === "failed" || !settled.text) {
          return Response.json({ status: settled.status, text: "", reason: settled.reason }, { status: 502 });
        }
        return Response.json({ status: settled.status, text: settled.text });
      } catch (err) {
        console.warn(
          JSON.stringify({
            type: "mano_turn_error",
            handle: body.handleHash,
            err: err instanceof Error ? err.name : "unknown",
            latencyMs: Date.now() - receivedMs,
          }),
        );
        if (err instanceof SettleTimeout) {
          return Response.json({ status: "timeout", text: "" }, { status: 504 });
        }
        return Response.json({ status: "error", text: "" }, { status: 502 });
      }
    }),
  ],
  events: {
    "turn.failed"(event, _channel, ctx) {
      console.warn(JSON.stringify({ type: "mano_turn_failed", session: ctx.session.id, terminal: event.terminal ?? false }));
    },
  },
});
