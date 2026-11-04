// Settles one synchronous turn: reads the session's event stream from
// the index where the turn's events start until the turn parks or ends,
// and reduces it to the single text Channels sends back. Assistant
// narration before a tool call is not a reply; only text from a step
// that finished with "stop" counts, falling back to the last text when
// no step did.
import type { AgentMarks } from "./timings.js";

export interface StreamEventLike {
  type: string;
  data?: Record<string, unknown>;
  // Eve's emission time for the event (ISO 8601).
  meta?: { at?: string };
}

export type SettleStatus = "replied" | "failed";

export interface SettleResult {
  status: SettleStatus;
  // The reply, or "" when the turn failed.
  text: string;
  // Machine-safe reason for logs: stop, tool_fallback, input, failed.
  reason: string;
  // The approvals this run's form calls left waiting for the person's YES,
  // read from the run's own tool results. Only these can be shown.
  held?: string[];
}

export interface SettleState {
  stopTexts: string[];
  lastText: string | null;
  // This run's Mano turn; a form result from another turn is ignored.
  turnId: string | null;
  // Per form, what its last form call in this turn left waiting, or null.
  heldByForm: Map<string, string | null>;
}

export function initialSettleState(turnId: string | null = null): SettleState {
  return { stopTexts: [], lastText: null, turnId, heldByForm: new Map() };
}

const FORM_TOOLS: ReadonlySet<string> = new Set(["fill_form", "start_form_draft"]);

// Only the last form call per form counts: one that did not end waiting
// for a YES means nothing earlier for that form is shown, in any instance,
// since this reads only the run's own events. A result from another turn
// (a fill that outlived its turn) is ignored. A call that failed names no
// form, so it could be correcting any of them.
function noteFormResult(state: SettleState, data: Record<string, unknown>): void {
  const result = data.result as { kind?: unknown; toolName?: unknown; output?: unknown } | undefined;
  if (result?.kind !== "tool-result" || typeof result.toolName !== "string" || !FORM_TOOLS.has(result.toolName)) return;
  const output = result.output as { status?: unknown; approvalId?: unknown; form?: unknown; turn?: unknown } | null | undefined;
  if (data.status === "completed" && output?.status === "unknown_form") return;
  if (data.status !== "completed" || typeof output?.form !== "string") {
    for (const form of state.heldByForm.keys()) state.heldByForm.set(form, null);
    return;
  }
  if (output.turn !== state.turnId) return;
  state.heldByForm.set(output.form, output.status === "waiting_for_yes" && typeof output.approvalId === "string" ? output.approvalId : null);
}

export function heldOf(state: SettleState): string[] {
  return [...state.heldByForm.values()].filter((id): id is string => id !== null);
}

// Returns a terminal result when the event ends the turn, else null.
export function reduceSettleEvent(state: SettleState, event: StreamEventLike): SettleResult | null {
  const data = event.data ?? {};
  switch (event.type) {
    case "action.result": {
      noteFormResult(state, data);
      return null;
    }
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
        return { status: "replied", text: state.stopTexts.join("\n"), reason: "stop", held: heldOf(state) };
      }
      if (state.lastText) {
        return { status: "replied", text: state.lastText, reason: "tool_fallback", held: heldOf(state) };
      }
      return { status: "failed", text: "", reason: "empty", held: heldOf(state) };
    }
    case "turn.failed":
    case "session.failed": {
      return { status: "failed", text: "", reason: "failed", held: heldOf(state) };
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
  opts: { timeoutMs: number; signal?: AbortSignal; marks?: AgentMarks; turnId?: string },
): Promise<SettleResult> {
  const state = initialSettleState(opts.turnId ?? null);
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
          ? { status: "replied", text: state.stopTexts.join("\n"), reason: "stop", held: heldOf(state) }
          : { status: "failed", text: "", reason: "closed", held: heldOf(state) };
      }
      opts.marks?.observe(value);
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
