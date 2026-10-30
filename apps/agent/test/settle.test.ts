import { describe, expect, it } from "vitest";

import {
  initialSettleState,
  reduceSettleEvent,
  settleStream,
  SettleTimeout,
  startIndexFor,
  type StreamEventLike,
} from "../agent/lib/settle.js";

function event(type: string, data: Record<string, unknown> = {}): StreamEventLike {
  return { type, data };
}

function streamOf(events: StreamEventLike[]): ReadableStream<StreamEventLike> {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  });
}

describe("settle reducer", () => {
  it("returns stop text and skips tool narration", async () => {
    const result = await settleStream(
      streamOf([
        event("message.completed", { message: "Let me check.", finishReason: "tool-calls" }),
        event("action.result", {}),
        event("message.completed", { message: "Your renewal is due Nov 15.", finishReason: "stop" }),
        event("turn.completed", {}),
      ]),
      { timeoutMs: 1000 },
    );
    expect(result).toEqual({ status: "replied", text: "Your renewal is due Nov 15.", reason: "stop" });
  });

  it("falls back to the last text when no step stopped", async () => {
    const result = await settleStream(
      streamOf([
        event("message.completed", { message: "On it.", finishReason: "tool-calls" }),
        event("session.waiting", {}),
      ]),
      { timeoutMs: 1000 },
    );
    expect(result.status).toBe("replied");
    expect(result.text).toBe("On it.");
  });

  it("fails closed when a turn parks on Eve input instead of an Engine approval", async () => {
    const result = await settleStream(
      streamOf([
        event("input.requested", { requests: [{ requestId: "req_1", prompt: "Submit it?" }] }),
        event("turn.waiting", { on: "input" }),
      ]),
      { timeoutMs: 1000 },
    );
    expect(result).toEqual({ status: "failed", text: "", reason: "input" });
  });

  it("fails the turn on failure events and empty closes", async () => {
    const failed = await settleStream(streamOf([event("turn.failed", {})]), { timeoutMs: 1000 });
    expect(failed.status).toBe("failed");
    const closed = await settleStream(streamOf([]), { timeoutMs: 1000 });
    expect(closed.status).toBe("failed");
  });

  it("times out a turn that never settles", async () => {
    const hanging = new ReadableStream<StreamEventLike>({ start() {} });
    await expect(settleStream(hanging, { timeoutMs: 20 })).rejects.toBeInstanceOf(SettleTimeout);
  });

  it("ignores events that do not end the turn", () => {
    expect(reduceSettleEvent(initialSettleState(), event("step.started", {}))).toBeNull();
  });

  it("bounds the stream read to the turn's session", () => {
    expect(startIndexFor("s1", 15, "s1")).toBe(16);
    expect(startIndexFor(null, -1, "s2")).toBe(0);
    // A send that replaced a stranded session reads the fresh stream.
    expect(startIndexFor("old", 41, "new")).toBe(0);
  });
});
