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
  it("labels Engine routes by template, never by the ID however it is spelled", () => {
    expect(engineRoute("POST", "/turns/eval-3f2a9c1e-77aa/complete")).toBe("POST /turns/:id/complete");
    expect(engineRoute("GET", "/pending-approval?generation=0")).toBe("GET /pending-approval");
    expect(engineRoute("POST", "/approvals/supersede")).toBe("POST /approvals/supersede");
    expect(engineRoute("POST", "/approvals/fence")).toBe("POST /approvals/fence");
    expect(engineRoute("POST", "/approvals/maria-garcia/retire")).toBe("POST /approvals/:id/retire");
    expect(engineRoute("GET", "/shares")).toBe("GET /shares");
    expect(engineRoute("GET", "/documents/maria-garcia")).toBe("GET /documents/:id");
    expect(engineRoute("PATCH", "/documents/maria")).toBe("PATCH /documents/:id");
    expect(engineRoute("GET", "/turns/approve")).toBe("GET /turns/:id");
    expect(engineRoute("DELETE", "/memory/lives-in-king-county")).toBe("DELETE /memory/:id");
    expect(engineRoute("POST", "/approvals/maria-garcia")).toBe("other");
    expect(engineRoute("GET", "/maria-garcia")).toBe("other");
    expect(engineRoute("GET", "/documents/maria-garcia/page")).toBe("other");
  });

  it("counts each Engine route and sums its time", () => {
    const clock = new TurnClock();
    clock.engineCall("GET /approvals", 40);
    clock.engineCall("GET /approvals", 25);
    clock.engineCall("POST /turns", 90);
    expect(clock.engine).toEqual({ "GET /approvals": [2, 65], "POST /turns": [1, 90] });
  });

  it("splits an agent run by the times Eve stamped on its events, a slow tool counted as tools", async () => {
    const marks = new AgentMarks(base);
    // The order Eve emits a tool step in: the model streams the call, the
    // tool runs (here a five-second memory write), then the step completes.
    const result = await settleStream(
      streamOf([
        { type: "turn.started", meta: at(300) },
        { type: "step.started", meta: at(1_100) },
        { type: "reasoning.appended", meta: at(1_900) },
        { type: "action.input.appended", meta: at(2_600) },
        { type: "actions.requested", meta: at(2_700) },
        { type: "action.result", meta: at(7_700) },
        { type: "reasoning.completed", meta: at(7_710) },
        { type: "step.completed", meta: at(7_710) },
        { type: "step.started", meta: at(7_800) },
        { type: "reasoning.appended", meta: at(8_300) },
        { type: "message.appended", meta: at(8_600) },
        { type: "message.completed", data: { message: "Saved. I'll remember that.", finishReason: "stop" }, meta: at(8_610) },
        { type: "step.completed", meta: at(8_610) },
        { type: "turn.completed", meta: at(8_620) },
      ]),
      { timeoutMs: 1_000, marks },
    );
    expect(result.text).toBe("Saved. I'll remember that.");
    const timings: Record<string, number> = {};
    marks.write(timings);
    expect(timings).toEqual({ steps: 2, queue: 300, setup: 800, ttft: 800, model: 2_400, tools: 5_000, other: 120 });
  });

  it("leaves out what a stream without stamps cannot show", () => {
    const marks = new AgentMarks(base);
    marks.observe({ type: "turn.started" });
    const timings: Record<string, number> = {};
    marks.write(timings);
    expect(timings).toEqual({ steps: 0, model: 0, tools: 0 });
  });
});
