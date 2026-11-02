// Settles one synchronous turn: reads the session's event stream from
// the index where the turn's events start until the turn parks or ends,
// and reduces it to the single text Channels sends back. Assistant
// narration before a tool call is not a reply; only text from a step
// that finished with "stop" counts, falling back to the last text when
// no step did.
export interface StreamEventLike {
  type: string;
  data?: Record<string, unknown>;
}

export type SettleStatus = "replied" | "failed";

export interface SettleResult {
  status: SettleStatus;
  // The reply, or "" when the turn failed.
  text: string;
  // Machine-safe reason for logs: stop, tool_fallback, input, failed.
  reason: string;
}

export interface SettleState {
  stopTexts: string[];
  lastText: string | null;
}

export function initialSettleState(): SettleState {
  return { stopTexts: [], lastText: null };
}

// Returns a terminal result when the event ends the turn, else null.
export function reduceSettleEvent(state: SettleState, event: StreamEventLike): SettleResult | null {
  const data = event.data ?? {};
  switch (event.type) {
    case "message.completed": {
      const message = typeof data.message === "string" ? data.message : "";
      if (message) {
        state.lastText = message;
        if (data.finishReason === "stop") state.stopTexts.push(message);
      }
      return null;
    }
    case "turn.waiting": {
      // No Mano tool parks on Eve input: approvals are Engine approvals
      // answered by text. A turn that parks anyway fails closed.
      if (data.on === "input") return { status: "failed", text: "", reason: "input" };
      return null;
    }
    case "turn.completed":
    case "session.waiting": {
      if (state.stopTexts.length > 0) {
        return { status: "replied", text: state.stopTexts.join("\n"), reason: "stop" };
      }
      if (state.lastText) {
        return { status: "replied", text: state.lastText, reason: "tool_fallback" };
      }
      return { status: "failed", text: "", reason: "empty" };
    }
    case "turn.failed":
    case "session.failed": {
      return { status: "failed", text: "", reason: "failed" };
    }
    default:
      return null;
  }
}

// Bounds the stream read to the turn's own events. A send that replaced
// a stranded session owns a fresh stream, so the old tail is discarded
// and the read starts at zero.
export function startIndexFor(existingId: string | null, tailBefore: number, sessionId: string): number {
  return sessionId === existingId ? tailBefore + 1 : 0;
}

export class SettleTimeout extends Error {
  constructor() {
    super("Turn did not settle in time.");
    this.name = "SettleTimeout";
  }
}

export async function settleStream(
  stream: ReadableStream<StreamEventLike>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SettleResult> {
  const state = initialSettleState();
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SettleTimeout()), opts.timeoutMs);
  });
  const read = (async (): Promise<SettleResult> => {
    for (;;) {
      if (opts.signal?.aborted) throw new SettleTimeout();
      const { done, value } = await reader.read();
      if (done) {
        return state.stopTexts.length > 0
          ? { status: "replied", text: state.stopTexts.join("\n"), reason: "stop" }
          : { status: "failed", text: "", reason: "closed" };
      }
      const terminal = reduceSettleEvent(state, value);
      if (terminal) {
        await reader.cancel().catch(() => undefined);
        return terminal;
      }
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}
