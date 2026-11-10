import { describe, expect, test, vi } from "vitest";
import { PlaywrightComputer, type BrowserLauncher, type FileChooserLike, type PageLike } from "../src/playwright";

/** A page that records calls and never touches a browser. */
function stubPage(): PageLike & {
  calls: string[];
  chooserHandler: ((chooser: FileChooserLike) => void) | null;
} {
  const calls: string[] = [];
  const stub = {
    calls,
    chooserHandler: null as ((chooser: FileChooserLike) => void) | null,
    async goto(next: string) {
      calls.push(`goto ${next}`);
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

function recordingLauncher() {
  const page = stubPage();
  let allowRequest: ((url: string) => boolean) | null = null;
  const launcher: BrowserLauncher & { page: typeof page; allow(url: string): boolean; bypass: string[] | null } = {
    page,
    bypass: null,
    allow: (url) => allowRequest!(url),
    launch: async (options) => {
      allowRequest = options.allowRequest;
      launcher.bypass = options.bypass;
      return { page, close: async () => undefined };
    },
  };
  return launcher;
}

describe("playwright stand-in around a navigation", () => {
  test("a batch that can navigate waits before the next screen, and typing alone does not", async () => {
    const launcher = recordingLauncher();
    const computer = new PlaywrightComputer({ launcher, allowedOrigins: ["http://portal.test"] });
    await computer.act([{ type: "type", text: "a" }]);
    expect(launcher.page.calls).toEqual(["type a"]);
    await computer.act([{ type: "click", button: "left", x: 1, y: 2 }, { type: "type", text: "b" }]);
    expect(launcher.page.calls.slice(1)).toEqual(["click 1,2 left x1", "type b", "wait 300"]);
  });

  test("a screenshot that hangs is tried once more within a short limit", async () => {
    const launcher = recordingLauncher();
    const computer = new PlaywrightComputer({ launcher, allowedOrigins: ["http://portal.test"] });
    const limits: Array<number | undefined> = [];
    let tries = 0;
    launcher.page.screenshot = async (options) => {
      limits.push(options?.timeout);
      if (++tries === 1) throw new Error("page.screenshot: Timeout exceeded");
      return Buffer.from([137, 80, 78, 71]);
    };
    expect(await computer.screenshot()).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(limits).toEqual([8000, 8000]);
    tries = 0;
    launcher.page.screenshot = async () => {
      tries++;
      throw new Error("page.screenshot: Timeout exceeded");
    };
    await expect(computer.screenshot()).rejects.toThrow("Timeout");
    expect(tries).toBe(2);
  });
});

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
      { type: "keypress", keys: ["Ctrl", "a"] },
      { type: "keypress", keys: ["ctrl", "A"] },
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
      "press Control+a",
      "press Control+A",
      "move 7,8",
      "move 9,9",
      "wheel 0,100",
      "type Maria",
      "wait 1500",
      "wait 300",
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

  test("before the first page opens, every request is refused", async () => {
    const launcher = recordingLauncher();
    const computer = new PlaywrightComputer({ launcher });
    await computer.screenshot();
    expect(launcher.allow("https://portal.test/apply")).toBe(false);
    expect(launcher.allow("about:blank")).toBe(false);
    expect(launcher.bypass).toEqual([]);
    await computer.close();
  });

  test("the first page the caller opens fixes the one allowed origin", async () => {
    const launcher = recordingLauncher();
    const computer = new PlaywrightComputer({ launcher });
    await computer.goto("https://portal.test/apply");
    expect(launcher.page.calls).toEqual(["goto https://portal.test/apply"]);
    expect(launcher.bypass).toEqual(["https://portal.test:443"]);
    expect(launcher.allow("https://portal.test/review?step=2")).toBe(true);
    for (const url of ["https://elsewhere.test/", "http://portal.test/apply", "https://portal.test.elsewhere.test/", "https://sub.portal.test/", "file:///etc/passwd", "data:text/html,hi"]) {
      expect(launcher.allow(url), url).toBe(false);
    }
    await computer.goto("https://elsewhere.test/");
    expect(launcher.allow("https://elsewhere.test/")).toBe(false);
    await computer.close();
  });

  test("configured origins win over the first page", async () => {
    const launcher = recordingLauncher();
    const computer = new PlaywrightComputer({ launcher, allowedOrigins: ["https://portal.test"] });
    await computer.goto("https://elsewhere.test/");
    expect(launcher.allow("https://elsewhere.test/")).toBe(false);
    expect(launcher.allow("https://portal.test/apply")).toBe(true);
    await computer.close();
  });

  test("a file picker is answered with no file", async () => {
    const page = stubPage();
    const computer = new PlaywrightComputer({ launcher: { launch: async () => ({ page, close: async () => undefined }) } });
    await computer.goto("https://portal.test/apply");
    const filled: Array<string | string[]> = [];
    page.chooserHandler?.({ setFiles: async (paths) => void filled.push(paths) });
    await new Promise((r) => setTimeout(r, 10));
    expect(filled).toEqual([[]]);
    await computer.close();
  });
});
