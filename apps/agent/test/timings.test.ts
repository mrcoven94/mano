import { describe, expect, it } from "vitest";

import { settleStream, type StreamEventLike } from "../agent/lib/settle.js";
import { AgentMarks, TurnClock, engineRoute } from "../agent/lib/timings.js";

const at = (ms: number) => ({ at: new Date(Date.UTC(2026, 10, 3) + ms).toISOString() });
const base = Date.UTC(2026, 10, 3);

function streamOf(events: StreamEventLike[]): ReadableStream<StreamEventLike> {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(e);
      controller.close();
    },
  });
}

describe("turn timings", () => {
  it("labels Engine routes without IDs or queries", () => {
    expect(engineRoute("POST", "/turns/eval-3f2a9c1e-77aa/complete")).toBe("POST /turns/:id/complete");
    expect(engineRoute("GET", "/pending-approval?generation=0")).toBe("GET /pending-approval");
    expect(engineRoute("POST", "/approvals/supersede")).toBe("POST /approvals/supersede");
    expect(engineRoute("GET", "/turns/d-0a1b2c-unshown")).toBe("GET /turns/:id");
  });

  it("counts each Engine route and sums its time", () => {
    const clock = new TurnClock();
    clock.engineCall("GET /approvals", 40);
    clock.engineCall("GET /approvals", 25);
    clock.engineCall("POST /turns", 90);
    expect(clock.engine).toEqual({ "GET /approvals": [2, 65], "POST /turns": [1, 90] });
  });

  it("splits an agent run by the times Eve stamped on its events", async () => {
    const marks = new AgentMarks(base);
    const result = await settleStream(
      streamOf([
        { type: "turn.started", meta: at(300) },
        { type: "step.started", meta: at(1_100) },
        { type: "reasoning.appended", meta: at(1_900) },
        { type: "message.completed", data: { message: "Checking.", finishReason: "tool-calls" }, meta: at(3_000) },
        { type: "step.completed", meta: at(3_100) },
        { type: "action.result", meta: at(3_400) },
        { type: "step.started", meta: at(3_500) },
        { type: "message.completed", data: { message: "Hi, I'm Mano.", finishReason: "stop" }, meta: at(5_000) },
        { type: "step.completed", meta: at(5_100) },
        { type: "turn.completed", meta: at(5_200) },
      ]),
      { timeoutMs: 1_000, marks },
    );
    expect(result.text).toBe("Hi, I'm Mano.");
    const timings: Record<string, number> = {};
    marks.write(timings);
    expect(timings).toEqual({ steps: 2, queue: 300, setup: 800, ttft: 800, model: 3_600, tools: 500 });
  });

  it("leaves out what a stream without stamps cannot show", () => {
    const marks = new AgentMarks(base);
    marks.observe({ type: "turn.started" });
    const timings: Record<string, number> = {};
    marks.write(timings);
    expect(timings).toEqual({ steps: 0, model: 0 });
  });
});
