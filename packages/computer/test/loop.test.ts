import { describe, expect, test } from "vitest";
import type { SafetyCheck } from "../src/actions";
import { runLoop } from "../src/loop";
import { FakeModelClient } from "../src/model";
import { assistantMessage, computerCall, FAKE_PNG, FakeComputer } from "./fake-computer";

const MODEL = "test-model";

describe("observe-act loop", () => {
  test("runs actions and finishes on the assistant message", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([
      [computerCall("call-1", [{ type: "click", button: "left", x: 10, y: 20 }])],
      [assistantMessage("KEY=k CONFIRMATION=SR-X DIGEST=" + "a".repeat(64))],
    ]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome.status).toBe("done");
    expect(outcome).toMatchObject({ steps: 2 });
    expect(computer.actions).toEqual([[{ type: "click", button: "left", x: 10, y: 20 }]]);
    expect(computer.urls).toEqual([]);
  });

  test("every call sends store:false and replays the trajectory verbatim", async () => {
    const computer = new FakeComputer();
    const first = computerCall("call-1", [{ type: "type", text: "hi" }], { meta_safety_replay_receipt: "receipt-1" });
    const model = new FakeModelClient([[first], [assistantMessage("done")]]);
    await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.store).toBe(false);
    expect(model.requests[1]?.store).toBe(false);
    const replayed = model.requests[1]?.input as unknown[];
    expect(replayed).toHaveLength(3);
    expect(replayed[1]).toMatchObject({ type: "computer_call", call_id: "call-1", meta_safety_replay_receipt: "receipt-1" });
    const output = replayed[2] as Record<string, unknown>;
    expect(output["type"]).toBe("computer_call_output");
    expect(output["call_id"]).toBe("call-1");
    const shot = (output["output"] as Record<string, unknown>)["image_url"] as string;
    expect(shot).toBe(`data:image/png;base64,${Buffer.from(FAKE_PNG).toString("base64")}`);
  });

  test("safety checks fail closed and run nothing", async () => {
    const computer = new FakeComputer();
    const call = computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 1 }]);
    call["pending_safety_checks"] = [{ id: "csc-1", code: "suspicious", message: "Are you sure?" }];
    const model = new FakeModelClient([[call]]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome.status).toBe("safety_declined");
    expect(computer.actions).toEqual([]);
  });

  test("approved checks are echoed on the output", async () => {
    const computer = new FakeComputer();
    const check: SafetyCheck = { id: "csc-1", code: "ok", message: "Fine." };
    const call = computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 1 }]);
    call["pending_safety_checks"] = [check];
    const model = new FakeModelClient([[call], [assistantMessage("done")]]);
    const seen: SafetyCheck[] = [];
    const outcome = await runLoop(computer, model, "do the thing", {
      model: MODEL,
      onSafetyCheck: async (c) => {
        seen.push(c);
        return true;
      },
    });
    expect(outcome.status).toBe("done");
    expect(seen).toEqual([check]);
    const output = (model.requests[1]?.input as unknown[])[2] as Record<string, unknown>;
    expect(output["acknowledged_safety_checks"]).toEqual([check]);
    expect(computer.actions).toHaveLength(1);
  });

  test("a credentials request pauses for the person, then continues with a fresh screenshot", async () => {
    const computer = new FakeComputer("https://live.test/view");
    const model = new FakeModelClient([[assistantMessage("CREDENTIALS NEEDED on the login page")], [assistantMessage("done")]]);
    const views: Array<string | null> = [];
    const outcome = await runLoop(computer, model, "do the thing", {
      model: MODEL,
      onCredentialsNeeded: async (url) => {
        views.push(url);
      },
    });
    expect(outcome.status).toBe("done");
    expect(views).toEqual(["https://live.test/view"]);
    const resumed = model.requests[1]?.input as unknown[];
    const last = resumed[resumed.length - 1] as { content: Array<Record<string, unknown>> };
    expect(last.content.some((b) => b["type"] === "input_image")).toBe(true);
  });

  test("an INFEASIBLE reply ends the run without acting", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage("INFEASIBLE: the portal is down")]]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome).toEqual({ status: "infeasible", message: "INFEASIBLE: the portal is down", steps: 1 });
    expect(computer.actions).toEqual([]);
  });

  test("the step budget stops a run that never finishes", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([
      [computerCall("call-1", [{ type: "wait" }])],
      [computerCall("call-2", [{ type: "wait" }])],
    ]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL, maxSteps: 2 });
    expect(outcome).toEqual({ status: "step_budget", steps: 2 });
    expect(computer.actions).toHaveLength(2);
  });
});
