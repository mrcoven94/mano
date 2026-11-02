import { describe, expect, test } from "vitest";
import type { ComputerAction } from "../src/actions";
import { runLoop } from "../src/loop";
import { FakeModelClient } from "../src/model";
import { recordFrames } from "../src/recorder";
import { assistantMessage, computerCall, FakeComputer } from "./fake-computer";

// A form whose screenshot is its own state, so a frame shows what was on
// screen when it was taken: the page, and the text typed into it so far.
class FormScreen extends FakeComputer {
  page = "blank";
  typed: string[] = [];

  override async screenshot(): Promise<Uint8Array> {
    await super.screenshot();
    return new TextEncoder().encode(`${this.page}|${this.typed.join(",")}`);
  }

  override async act(actions: ComputerAction[]): Promise<void> {
    await super.act(actions);
    for (const a of actions) {
      if (a.type === "type") this.typed.push(a.text);
      if (a.type === "click" && a.y === 700) this.page = "next";
    }
  }

  override async goto(url: string): Promise<void> {
    await super.goto(url);
    this.page = "form";
  }
}

const shown = (png: Uint8Array) => new TextDecoder().decode(png);
const click = (y: number): ComputerAction => ({ type: "click", button: "left", x: 600, y });
const type = (text: string): ComputerAction => ({ type: "type", text });
const CONTINUE = click(700);

describe("recording a run", () => {
  test("a form filled in one batch shows each field filled, then the whole form before Continue", async () => {
    const screen = new FormScreen();
    const { computer, frames } = recordFrames(screen);
    await computer.goto("http://portal.test/apply");
    const batch = [click(100), type("Rosa"), click(150), { type: "keypress", keys: ["ctrl", "a"] } as ComputerAction, type("03/12/1984"), CONTINUE];
    const model = new FakeModelClient([[computerCall("call-1", batch)], [assistantMessage("ACCEPTED")]]);

    const outcome = await runLoop(computer, model, "fill the form", { model: "test-model" });

    expect(outcome.status).toBe("done");
    expect(frames().map((f) => shown(f.png))).toEqual(["form|", "form|Rosa", "form|Rosa,03/12/1984", "next|Rosa,03/12/1984"]);
    expect(frames().map((f) => f.actions)).toEqual([[], [click(100), type("Rosa")], [click(150), batch[3], type("03/12/1984")], [CONTINUE]]);
    // The desktop ran every action once, in order.
    expect(screen.actions.flat()).toEqual(batch);
  });

  test("a screenshot with nothing new since the last frame keeps no second frame", async () => {
    const screen = new FormScreen();
    const { computer, frames } = recordFrames(screen);
    await computer.goto("http://portal.test/apply");
    await computer.screenshot();
    await computer.act([click(100), type("Rosa")]);
    await computer.screenshot();
    await computer.screenshot();

    expect(frames().map((f) => shown(f.png))).toEqual(["form|", "form|Rosa"]);
    expect(screen.screenshots).toBe(4);
  });

  test("an action that fails stops the batch there, and the frames so far stay", async () => {
    const screen = new FormScreen();
    const { computer, frames } = recordFrames(screen);
    await computer.goto("http://portal.test/apply");
    await computer.screenshot();
    await computer.act([click(100), type("Rosa")]);
    screen.failOnAct = true;

    await expect(computer.act([click(150), type("Luis"), CONTINUE])).rejects.toThrow("actuator failed");
    expect(frames().map((f) => shown(f.png))).toEqual(["form|", "form|Rosa"]);
  });

  test("everything else reaches the desktop unchanged", async () => {
    const screen = new FormScreen();
    const { computer } = recordFrames(screen);
    expect(await computer.stageFile("stub.pdf", new Uint8Array([1]))).toBe("/staged/stub.pdf");
    expect(computer.fileUploadHint()).toBe("test picker hint");
    expect(computer.liveViewUrl()).toBeNull();
    await computer.close();
    expect(screen.closes).toBe(1);
  });
});
