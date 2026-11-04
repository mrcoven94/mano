import { describe, expect, test, vi } from "vitest";
import type { ComputerAction, SafetyCheck } from "../src/actions";
import { LOOP_INSTRUCTIONS, runLoop, type LoopOptions } from "../src/loop";
import { FakeModelClient } from "../src/model";
import { assistantMessage, computerCall, FAKE_PNG, FakeComputer } from "./fake-computer";

const MODEL = "test-model";

describe("observe-act loop", () => {
  test("runs actions and finishes on the assistant message", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([
      [computerCall("call-1", [{ type: "click", button: "left", x: 10, y: 20 }])],
      [assistantMessage("ACCEPTED")],
    ]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome).toEqual({ status: "done", message: "ACCEPTED", steps: 2 });
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
    expect(output["acknowledged_safety_checks"]).toEqual([]);
    const shot = (output["output"] as Record<string, unknown>)["image_url"] as string;
    expect(shot).toBe(`data:image/png;base64,${Buffer.from(FAKE_PNG).toString("base64")}`);
  });

  test.each([
    { id: "csc-1", code: "computer_action_requires_confirmation", message: "Confirm this action." },
    { id: "csc-2", code: "malicious_instructions", message: "The page gives instructions." },
  ])("a pending $code check stops the run and goes back to the caller", async (check: SafetyCheck) => {
    const computer = new FakeComputer();
    const call = computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 1 }]);
    call["pending_safety_checks"] = [check];
    const model = new FakeModelClient([[call], [assistantMessage("done")]]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome).toEqual({ status: "safety_check", checks: [check], steps: 1 });
    expect(computer.actions).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  test("no caller option can acknowledge a safety check", async () => {
    const computer = new FakeComputer();
    const call = computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 1 }]);
    call["pending_safety_checks"] = [{ id: "csc-1", code: "computer_action_requires_confirmation", message: "Confirm." }];
    const model = new FakeModelClient([[call], [assistantMessage("done")]]);
    const approving = { model: MODEL, onSafetyCheck: async () => true } as LoopOptions;
    const outcome = await runLoop(computer, model, "do the thing", approving);
    expect(outcome.status).toBe("safety_check");
    expect(computer.actions).toEqual([]);
  });

  test("a credentials request ends the run as infeasible", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage("CREDENTIALS NEEDED on the login page")], [assistantMessage("done")]]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome).toEqual({ status: "infeasible", message: "CREDENTIALS NEEDED on the login page", steps: 1 });
    expect(model.requests).toHaveLength(1);
    expect(computer.actions).toEqual([]);
  });

  test("an INFEASIBLE reply ends the run without acting", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[assistantMessage("INFEASIBLE: the portal is down")]]);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL });
    expect(outcome).toEqual({ status: "infeasible", message: "INFEASIBLE: the portal is down", steps: 1 });
    expect(computer.actions).toEqual([]);
  });

  test("each turn logs its time and action types, and never a typed value", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const model = new FakeModelClient([
      [computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 2 }, { type: "type", text: "Maria Torres" }])],
      [assistantMessage("ACCEPTED")],
    ]);
    await runLoop(new FakeComputer(), model, "task", { model: MODEL });
    const logged = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ type: "mano_computer_turn", step: 1, actions: "click,type" });
    expect(logged[0]).not.toMatch(/Maria/);
  });

  test("a refused batch logs its key names and earlier turns, and never a typed value or an unknown word", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const model = new FakeModelClient([
      [computerCall("call-1", [{ type: "click", button: "left", x: 1, y: 2 }, { type: "type", text: "Maria Torres" }])],
      [computerCall("call-2", [{ type: "type", text: "418 Alder St" }, { type: "keypress", keys: ["ctrl", "Maria"] }, { type: "keypress", keys: ["Home"] }])],
    ]);
    const outcome = await runLoop(new FakeComputer(), model, "task", { model: MODEL });
    expect(outcome).toEqual({ status: "refused", steps: 2 });
    const logged = String(warn.mock.calls[0]?.[0]);
    warn.mockRestore();
    expect(JSON.parse(logged)).toEqual({
      type: "mano_computer_refused",
      turns: ["click,type"],
      refused: [{ type: "type" }, { type: "keypress", keys: ["ctrl", "other"] }, { type: "keypress", keys: ["Home"] }],
    });
    expect(logged).not.toMatch(/Maria|Alder/);
  });

  test("replay stops at 29 pairs instead of sending a refused request", async () => {
    const computer = new FakeComputer();
    const turns = Array.from({ length: 29 }, (_, i) => [computerCall(`call-${i}`, [{ type: "wait" }])]);
    const model = new FakeModelClient(turns);
    const outcome = await runLoop(computer, model, "do the thing", { model: MODEL, maxSteps: 35 });
    expect(outcome).toEqual({ status: "step_budget", steps: 29 });
    expect(model.requests).toHaveLength(29);
  });

  test("each turn is reported through the progress callback", async () => {
    const computer = new FakeComputer();
    const model = new FakeModelClient([[computerCall("call-1", [{ type: "wait" }])], [assistantMessage("done")]]);
    const turns: unknown[] = [];
    await runLoop(computer, model, "do the thing", { model: MODEL, onTurn: (turn) => void turns.push(turn) });
    expect(turns).toEqual([{ step: 1, call: [{ type: "wait" }] }, { step: 2, message: "done" }]);
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

  describe("what a model may press and click, on any model path", () => {
    const refusedKeys = [["alt", "F2"], ["Alt+F2"], ["alt", "F1"], ["alt", "F4"], ["alt", "Tab"], ["F2"], ["super"], ["meta", "d"], ["ctrl", "l"], ["ctrl", "t"], ["ctrl", "n"], ["ctrl", "o"], ["ctrl", "s"], ["ctrl", "shift", "i"], ["ctrl", "alt", "t"], ["ctrl", "a", "l"], ["shift", "a"], ["a"], [" "], ["constructor"], []];

    test.each(refusedKeys.map((keys) => [keys]))("%j stops the run before anything in its batch acts", async (keys) => {
      const computer = new FakeComputer();
      const batch: ComputerAction[] = [{ type: "click", button: "left", x: 1, y: 1 }, { type: "keypress", keys }, { type: "wait" }, { type: "type", text: "touch /tmp/mano-escape" }, { type: "keypress", keys: ["Enter"] }];
      const outcome = await runLoop(computer, new FakeModelClient([[computerCall("call-1", batch)]]), "Go.", { model: MODEL });
      expect(outcome).toEqual({ status: "refused", steps: 1 });
      expect(computer.actions).toEqual([]);
    });

    test.each([
      [["Tab"], ["Tab"]],
      [["tab"], ["Tab"]],
      [["Enter"], ["Enter"]],
      [["return"], ["Enter"]],
      [["Backspace"], ["Backspace"]],
      [["DELETE"], ["Delete"]],
      [["esc"], ["Escape"]],
      [["Escape"], ["Escape"]],
      [["ArrowLeft"], ["ArrowLeft"]],
      [["right"], ["ArrowRight"]],
      [["UP"], ["ArrowUp"]],
      [["arrowdown"], ["ArrowDown"]],
      [["shift", "Tab"], ["Shift", "Tab"]],
      [["Shift+Tab"], ["Shift", "Tab"]],
      [["ctrl", "a"], ["ctrl", "a"]],
      [["Control", "A"], ["ctrl", "a"]],
    ])("%j reaches the computer as %j, and the call replays as the model sent it", async (keys, sent) => {
      const computer = new FakeComputer();
      const model = new FakeModelClient([[computerCall("call-1", [{ type: "keypress", keys }])], [assistantMessage("ok")]]);
      await runLoop(computer, model, "Go.", { model: MODEL });
      expect(computer.actions).toEqual([[{ type: "keypress", keys: sent }]]);
      expect(model.requests[1]!.input[1]).toMatchObject({ type: "computer_call", actions: [{ type: "keypress", keys }] });
    });

    test.each(["right", "wheel", "back", "forward"] as const)("a %s click is refused: only the left button fills a form", async (button) => {
      const computer = new FakeComputer();
      const outcome = await runLoop(computer, new FakeModelClient([[computerCall("call-1", [{ type: "click", button, x: 1, y: 1 }])]]), "Go.", { model: MODEL });
      expect(outcome).toEqual({ status: "refused", steps: 1 });
      expect(computer.actions).toEqual([]);
    });

    test("the model is told which keys it has", () => {
      expect(LOOP_INSTRUCTIONS).toContain("Tab, Shift+Tab, Enter, Backspace, Delete, Escape, the arrow keys and Ctrl+A");
    });
  });
});
