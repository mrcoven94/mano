import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { ComputerAction } from "./actions";
import type { Computer, ComputerOptions } from "./computer";

/** Smallest page surface the stand-in needs. Playwright's Page satisfies it. */
export interface MouseLike {
  click(x: number, y: number, options?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void>;
  move(x: number, y: number): Promise<void>;
  down(options?: { button?: "left" | "right" | "middle" }): Promise<void>;
  up(options?: { button?: "left" | "right" | "middle" }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface KeyboardLike {
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
}

export interface FileChooserLike {
  setFiles(paths: string | string[]): Promise<void>;
}

export interface PageLike {
  url(): string;
  goto(url: string): Promise<unknown>;
  goBack(): Promise<unknown>;
  screenshot(): Promise<Buffer>;
  waitForTimeout(ms: number): Promise<void>;
  mouse: MouseLike;
  keyboard: KeyboardLike;
  on(event: "filechooser", handler: (chooser: FileChooserLike) => void): void;
}

export interface LaunchedPage {
  page: PageLike;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(options: { headless: boolean; width: number; height: number; profileDir?: string }): Promise<LaunchedPage>;
}

export interface PlaywrightComputerOptions extends ComputerOptions {
  /** Run headless. Defaults to true. */
  headless?: boolean;
  /** Persistent profile directory (per person). Defaults to a temp dir. */
  profileDir?: string;
  /** Origins the page may stay on. Defaults to the first page opened. */
  allowedOrigins?: string[];
  /** Injected for tests. Defaults to real Chromium. */
  launcher?: BrowserLauncher;
}

/** Local stand-in: real Chromium on this machine behind the Computer interface. */
export class PlaywrightComputer implements Computer {
  private launched: LaunchedPage | null = null;
  private launching: Promise<LaunchedPage> | null = null;
  private staged: string[] = [];
  private scratch: string | null = null;
  private origins: string[] | null;
  private closed = false;

  constructor(private options: PlaywrightComputerOptions = {}) {
    this.origins = options.allowedOrigins ? [...options.allowedOrigins] : null;
  }

  private launcher(): BrowserLauncher {
    if (this.options.launcher) return this.options.launcher;
    return {
      launch: async (opts) => {
        if (this.options.profileDir) {
          const context = await chromium.launchPersistentContext(this.options.profileDir, {
            headless: opts.headless,
            viewport: { width: opts.width, height: opts.height },
            deviceScaleFactor: 1,
          });
          const page = await context.newPage();
          return { page: page as unknown as PageLike, close: () => context.close() };
        }
        const browser = await chromium.launch({ headless: opts.headless });
        const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        return { page: page as unknown as PageLike, close: () => browser.close() };
      },
    };
  }

  private async started(): Promise<LaunchedPage> {
    if (this.closed) throw new Error("computer is closed");
    if (this.launched) return this.launched;
    if (!this.launching) {
      const profileDir = this.options.profileDir;
      this.launching = this.launcher()
        .launch({
          headless: this.options.headless ?? true,
          width: this.options.width ?? 1280,
          height: this.options.height ?? 800,
          ...(profileDir ? { profileDir } : {}),
        })
        .then((launched) => {
          // File pickers are answered with staged files in order; headless Chromium shows no dialog.
          launched.page.on("filechooser", (chooser) => {
            const next = this.staged.shift();
            void chooser.setFiles(next ? [next] : []);
          });
          this.launched = launched;
          return launched;
        });
    }
    return this.launching;
  }

  async screenshot(): Promise<Uint8Array> {
    const { page } = await this.started();
    return new Uint8Array(await page.screenshot());
  }

  async act(actions: ComputerAction[]): Promise<void> {
    const { page } = await this.started();
    for (const action of actions) {
      switch (action.type) {
        case "click":
          await page.mouse.click(action.x, action.y, { button: clickButton(action.button) });
          break;
        case "double_click":
          await page.mouse.click(action.x, action.y, { button: "left", clickCount: 2 });
          break;
        case "drag": {
          const [first, ...rest] = action.path;
          if (!first) throw new Error("drag needs at least one point");
          await page.mouse.move(first.x, first.y);
          await page.mouse.down({ button: "left" });
          try {
            for (const point of rest) await page.mouse.move(point.x, point.y);
          } finally {
            await page.mouse.up({ button: "left" });
          }
          break;
        }
        case "keypress":
          await page.keyboard.press(action.keys.map(normalizeKey).join("+"));
          break;
        case "move":
          await page.mouse.move(action.x, action.y);
          break;
        case "scroll":
          await page.mouse.move(action.x, action.y);
          await page.mouse.wheel(action.scroll_x, action.scroll_y);
          break;
        case "type":
          await page.keyboard.type(action.text);
          break;
        case "screenshot":
          break;
        case "wait":
          await page.waitForTimeout(1500);
          break;
      }
    }
    await this.stayInside(page);
  }

  async goto(url: string): Promise<void> {
    const { page } = await this.started();
    await page.goto(url);
    if (!this.origins) this.origins = [new URL(page.url()).origin];
    await this.stayInside(page);
  }

  async stageFile(name: string, data: Uint8Array): Promise<string> {
    if (!this.scratch) this.scratch = mkdtempSync(join(tmpdir(), "mano-computer-"));
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
    const path = join(this.scratch, safe);
    writeFileSync(path, data);
    this.staged.push(path);
    return path;
  }

  fileUploadHint(): string {
    return "Clicking a file button attaches the next staged file automatically; click once and wait for the file name to appear.";
  }

  liveViewUrl(): string | null {
    return null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.launching = null;
    if (this.launched) {
      await this.launched.close().catch(() => undefined);
      this.launched = null;
    }
    if (this.scratch) {
      rmSync(this.scratch, { recursive: true, force: true });
      this.scratch = null;
    }
  }

  private async stayInside(page: PageLike): Promise<void> {
    if (!this.origins) return;
    const here = page.url();
    if (here === "about:blank") return;
    if (!this.origins.includes(new URL(here).origin)) await page.goBack();
  }
}

const KEY_ALIASES: Record<string, string> = { Ctrl: "Control" };

function normalizeKey(key: string): string {
  return KEY_ALIASES[key] ?? key;
}

function clickButton(button: "left" | "right" | "wheel" | "back" | "forward"): "left" | "right" | "middle" {
  if (button === "left" || button === "right") return button;
  if (button === "wheel") return "middle";
  throw new Error(`mouse button ${button} is not supported`);
}
