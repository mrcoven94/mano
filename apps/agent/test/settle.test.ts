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
    expect(result).toEqual({ status: "replied", text: "Your renewal is due Nov 15.", reason: "stop", held: [] });
  });

  // LAP-747: from this run's stream, only the last form call per form
  // counts, and only if it belongs to this turn.
  describe("what a run's form calls leave waiting", () => {
    const form = (output: unknown, status = "completed", toolName = "fill_form") => event("action.result", { status, result: { kind: "tool-result", callId: "c", toolName, output } });
    const own = (over: Record<string, unknown>) => ({ form: "food-renewal", turn: "turn-b", sent: false, ...over });
    const settled = (...events: ReturnType<typeof event>[]) =>
      settleStream(streamOf([...events, event("message.completed", { message: "Done.", finishReason: "stop" }), event("turn.completed", {})]), { timeoutMs: 1000, turnId: "turn-b" });

    it("holds the last call's approval, across both form tools", async () => {
      const out = await settled(
        form(own({ status: "unavailable" })),
        form(own({ status: "waiting_for_yes", approvalId: "ap-1" }), "completed", "start_form_draft"),
      );
      expect(out.held).toEqual(["ap-1"]);
    });

    it("shows nothing when the last call for the form did not end waiting", async () => {
      const out = await settled(form(own({ status: "waiting_for_yes", approvalId: "ap-1" })), form(own({ status: "needs_answer", field: "phone" })));
      expect(out.held).toEqual([]);
    });

    it("shows nothing when a later call failed, since it could be correcting any form", async () => {
      const out = await settled(form(own({ status: "waiting_for_yes", approvalId: "ap-1" })), form(null, "failed"));
      expect(out.held).toEqual([]);
    });

    it("ignores a result from another turn, before or after this turn's own", async () => {
      const foreign = { form: "food-renewal", turn: "turn-a", status: "waiting_for_yes", approvalId: "ap-a" };
      expect((await settled(form(foreign))).held).toEqual([]);
      expect((await settled(form(own({ status: "waiting_for_yes", approvalId: "ap-b" })), form(foreign))).held).toEqual(["ap-b"]);
    });

    it("ignores other tools and a form Mano cannot fill", async () => {
      const out = await settled(
        form(own({ status: "waiting_for_yes", approvalId: "ap-1" })),
        form({ status: "unknown_form", sent: false }),
        form({ status: "waiting_for_yes", approvalId: "ap-x" }, "completed", "update_profile"),
      );
      expect(out.held).toEqual(["ap-1"]);
    });
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
