import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  goto(url: string): Promise<unknown>;
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
  /** Every request of every page in the browser, popups included, must pass allowRequest before it is sent. */
  launch(options: {
    headless: boolean;
    width: number;
    height: number;
    profileDir?: string;
    allowRequest: (url: string) => boolean;
    /** Proxy bypass rules (scheme://host:port), one per allowed origin; all other traffic must fail. */
    bypass: string[];
  }): Promise<LaunchedPage>;
}

export interface PlaywrightComputerOptions extends ComputerOptions {
  /** Run headless. Defaults to true. */
  headless?: boolean;
  /** Persistent profile directory (per person). Defaults to a temp dir. */
  profileDir?: string;
  /** The only origins any request may go to. Defaults to the origin of the first page the caller opens. */
  allowedOrigins?: string[];
  /** Injected for tests. Defaults to real Chromium. */
  launcher?: BrowserLauncher;
}

/** Local stand-in: real Chromium on this machine behind the Computer interface. */
export class PlaywrightComputer implements Computer {
  private launched: LaunchedPage | null = null;
  private launching: Promise<LaunchedPage> | null = null;
  private staged: string[] = [];
  private choosers = 0;
  private scratch: string | null = null;
  private origins: string[] | null;
  private closed = false;

  constructor(private options: PlaywrightComputerOptions = {}) {
    this.origins = options.allowedOrigins ? options.allowedOrigins.map((o) => new URL(o).origin) : null;
  }

  private launcher(): BrowserLauncher {
    if (this.options.launcher) return this.options.launcher;
    return {
      launch: async (opts) => {
        // Loaded on first launch, so hosts that only drive the Modal desktop
        // never load the local browser.
        const { chromium } = await import("playwright");
        // Two layers. The route aborts off-origin requests in every page and
        // popup, but Playwright routes only the first hop of a redirect. So
        // Chromium also sends every origin but the allowed ones to a closed
        // local port: later hops fail before anything reaches another host.
        // Chromium reads bypass rules last to first, so <-loopback> (proxy
        // localhost too) goes first; this flag replaces Playwright's own.
        const launch = {
          headless: opts.headless,
          proxy: { server: "http://127.0.0.1:9" },
          args: [`--proxy-bypass-list=${["<-loopback>", ...opts.bypass].join(";")}`],
        };
        // Service workers would answer requests the route never sees.
        const contextOptions = { viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1, serviceWorkers: "block" as const };
        const browser = opts.profileDir ? null : await chromium.launch(launch);
        const context = opts.profileDir
          ? await chromium.launchPersistentContext(opts.profileDir, { ...launch, ...contextOptions })
          : await browser!.newContext(contextOptions);
        await context.route("**/*", (route) => (opts.allowRequest(route.request().url()) ? route.continue() : route.abort("blockedbyclient")));
        const page = await context.newPage();
        return { page: page as unknown as PageLike, close: () => (browser ? browser.close() : context.close()) };
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
          allowRequest: (url) => this.allows(url),
          bypass: (this.origins ?? []).map(bypassRule),
        })
        .then((launched) => {
          // File pickers are answered with staged files, cycling so a repeated
          // click refills the same input instead of clearing it. Headless
          // Chromium shows no dialog.
          launched.page.on("filechooser", (chooser) => {
            const next = this.staged.length > 0 ? this.staged[this.choosers++ % this.staged.length] : undefined;
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
  }

  /** The first call fixes the allowed origin when none was configured, so open the portal before anything else. */
  async goto(url: string): Promise<void> {
    this.origins ??= [new URL(url).origin];
    const { page } = await this.started();
    await page.goto(url);
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
    return "To attach a file, press Tab until a file button is focused, then press Enter; the staged file attaches automatically. One file per button; do not click a filled button again.";
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

  private allows(url: string): boolean {
    if (!this.origins) return false;
    try {
      const { protocol, origin } = new URL(url);
      return (protocol === "https:" || protocol === "http:") && this.origins.includes(origin);
    } catch {
      return false;
    }
  }
}

function bypassRule(origin: string): string {
  const { protocol, hostname, port } = new URL(origin);
  return `${protocol}//${hostname}:${port || (protocol === "https:" ? "443" : "80")}`;
}

const KEY_ALIASES: Record<string, string> = { ctrl: "Control", control: "Control", return: "Enter" };

function normalizeKey(key: string): string {
  if (key.length === 1) return key;
  return KEY_ALIASES[key.toLowerCase()] ?? key;
}

function clickButton(button: "left" | "right" | "wheel" | "back" | "forward"): "left" | "right" | "middle" {
  if (button === "left" || button === "right") return button;
  if (button === "wheel") return "middle";
  throw new Error(`mouse button ${button} is not supported`);
}
