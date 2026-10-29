// Settles one synchronous turn: reads the session's event stream from
// the index where the turn's events start until the turn parks or ends,
// and reduces it to the single text Channels sends back. Assistant
// narration before a tool call is not a reply; only text from a step
// that finished with "stop" counts, falling back to the last text when
// no step did. A turn parked on human input renders the pending request
// (prompt plus numbered options) so the person can answer by text.
export interface StreamEventLike {
  type: string;
  data?: Record<string, unknown>;
}

export type SettleStatus = "replied" | "waiting_input" | "failed";

export interface SettleResult {
  status: SettleStatus;
  // The reply, the rendered request, or "" when the turn failed.
  text: string;
  // Machine-safe reason for logs: stop, tool_fallback, input, failed.
  reason: string;
}

export interface SettleState {
  stopTexts: string[];
  lastText: string | null;
  requestText: string | null;
}

export function initialSettleState(): SettleState {
  return { stopTexts: [], lastText: null, requestText: null };
}

interface InputOptionLike {
  id?: unknown;
  label?: unknown;
}

interface InputRequestLike {
  prompt?: unknown;
  options?: unknown;
}

function asRequest(value: unknown): InputRequestLike | null {
  if (typeof value !== "object" || value === null) return null;
  return value as InputRequestLike;
}

// Renders one pending request as text: the prompt plus compact numbered
// options, so "1" or the label answers it on the next turn.
export function renderRequest(request: InputRequestLike): string {
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const options = Array.isArray(request.options) ? (request.options as InputOptionLike[]) : [];
  const labels = options
    .map((o) => (typeof o?.label === "string" ? o.label.trim() : ""))
    .filter((l) => l.length > 0);
  if (labels.length === 0) return prompt;
  const numbered = labels.map((l, i) => `${i + 1}) ${l}`).join(" ");
  return prompt ? `${prompt} Options: ${numbered}` : `Options: ${numbered}`;
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
    case "input.requested": {
      const requests = Array.isArray(data.requests) ? data.requests : [];
      const first = requests.map(asRequest).find((r) => r !== null);
      if (first && state.requestText === null) {
        const rendered = renderRequest(first);
        if (rendered) state.requestText = rendered;
      }
      return null;
    }
    case "turn.waiting": {
      if (data.on === "input") {
        return { status: "waiting_input", text: state.requestText ?? "", reason: "input" };
      }
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
      if (state.requestText) {
        return { status: "waiting_input", text: state.requestText, reason: "input" };
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
          : state.requestText
            ? { status: "waiting_input", text: state.requestText, reason: "input" }
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
