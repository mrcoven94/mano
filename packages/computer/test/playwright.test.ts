import { existsSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { PlaywrightComputer, type FileChooserLike, type PageLike } from "../src/playwright";

/** A page that records calls and never touches a browser. */
function stubPage(url = "https://portal.test/apply"): PageLike & {
  calls: string[];
  chooserHandler: ((chooser: FileChooserLike) => void) | null;
  currentUrl: string;
  goBacks: number;
} {
  const calls: string[] = [];
  const stub = {
    calls,
    chooserHandler: null as ((chooser: FileChooserLike) => void) | null,
    currentUrl: url,
    goBacks: 0,
    url() {
      return stub.currentUrl;
    },
    async goto(next: string) {
      calls.push(`goto ${next}`);
      stub.currentUrl = next;
    },
    async goBack() {
      calls.push("goBack");
      stub.goBacks += 1;
    },
    async screenshot() {
      calls.push("screenshot");
      return Buffer.from([137, 80, 78, 71]);
    },
    async waitForTimeout(ms: number) {
      calls.push(`wait ${ms}`);
    },
    mouse: {
      async click(x: number, y: number, options?: { button?: "left" | "right" | "middle"; clickCount?: number }) {
        calls.push(`click ${x},${y} ${options?.button ?? "left"} x${options?.clickCount ?? 1}`);
      },
      async move(x: number, y: number) {
        calls.push(`move ${x},${y}`);
      },
      async down() {
        calls.push("down");
      },
      async up() {
        calls.push("up");
      },
      async wheel(dx: number, dy: number) {
        calls.push(`wheel ${dx},${dy}`);
      },
    },
    keyboard: {
      async type(text: string) {
        calls.push(`type ${text}`);
      },
      async press(key: string) {
        calls.push(`press ${key}`);
      },
    },
    on(_event: "filechooser", handler: (chooser: FileChooserLike) => void) {
      stub.chooserHandler = handler;
    },
  };
  return stub;
}

describe("playwright stand-in", () => {
  test("dispatches every action to the page", async () => {
    const page = stubPage();
    const close = vi.fn(async () => undefined);
    const computer = new PlaywrightComputer({ launcher: { launch: async () => ({ page, close }) } });
    await computer.act([
      { type: "click", button: "left", x: 10, y: 20 },
      { type: "click", button: "right", x: 1, y: 2 },
      { type: "double_click", x: 3, y: 4 },
      { type: "drag", path: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
      { type: "keypress", keys: ["Control", "c"] },
      { type: "move", x: 7, y: 8 },
      { type: "scroll", x: 9, y: 9, scroll_x: 0, scroll_y: 100 },
      { type: "type", text: "Maria" },
      { type: "screenshot" },
      { type: "wait" },
    ]);
    expect(page.calls).toEqual([
      "click 10,20 left x1",
      "click 1,2 right x1",
      "click 3,4 left x2",
      "move 0,0",
      "down",
      "move 5,5",
      "up",
      "press Control+c",
      "move 7,8",
      "move 9,9",
      "wheel 0,100",
      "type Maria",
      "wait 1500",
    ]);
    const shot = await computer.screenshot();
    expect(shot[0]).toBe(137);
    await computer.close();
    expect(close).toHaveBeenCalledOnce();
    await computer.close();
    expect(close).toHaveBeenCalledOnce();
  });

  test("unsupported mouse buttons fail loud", async () => {
    const page = stubPage();
    const computer = new PlaywrightComputer({ launcher: { launch: async () => ({ page, close: async () => undefined }) } });
    await expect(computer.act([{ type: "click", button: "back", x: 1, y: 1 }])).rejects.toThrow("not supported");
    await computer.close();
  });

  test("leaving the allowed origin goes back", async () => {
    const page = stubPage();
    const computer = new PlaywrightComputer({ launcher: { launch: async () => ({ page, close: async () => undefined }) } });
    await computer.goto("https://portal.test/apply");
    expect(page.goBacks).toBe(0);
    page.currentUrl = "https://elsewhere.test/phish";
    await computer.act([{ type: "wait" }]);
    expect(page.goBacks).toBe(1);
    await computer.close();
  });

  test("file pickers are answered with staged files in order", async () => {
    const page = stubPage();
    const computer = new PlaywrightComputer({ launcher: { launch: async () => ({ page, close: async () => undefined }) } });
    await computer.goto("https://portal.test/apply");
    const first = await computer.stageFile("a.pdf", new TextEncoder().encode("%PDF-a"));
    const second = await computer.stageFile("b.pdf", new TextEncoder().encode("%PDF-b"));
    expect(existsSync(first)).toBe(true);
    const filled: Array<string | string[]> = [];
    const chooser = (handler: ((c: FileChooserLike) => void) | null) => handler?.({ setFiles: async (paths) => void filled.push(paths) });
    chooser(page.chooserHandler);
    chooser(page.chooserHandler);
    chooser(page.chooserHandler);
    await new Promise((r) => setTimeout(r, 10));
    expect(filled).toEqual([[first], [second], []]);
    await computer.close();
    expect(existsSync(first)).toBe(false);
  });

  test("the stand-in has no live view", async () => {
    const page = stubPage();
    const computer = new PlaywrightComputer({ launcher: { launch: async () => ({ page, close: async () => undefined }) } });
    expect(computer.liveViewUrl()).toBeNull();
    await computer.close();
  });
});
