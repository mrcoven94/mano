import type { ComputerAction } from "./actions";

/** A desktop with a browser, worked through screenshots, mouse and keyboard. */
export interface Computer {
  /** Capture the current screen as PNG bytes. Size must stay stable across a run. */
  screenshot(): Promise<Uint8Array>;
  /** Run one batch of actions in order. Stops early if an action fails. */
  act(actions: ComputerAction[]): Promise<void>;
  /** Open a page. Only the configured portal and pages it links to. */
  goto(url: string): Promise<void>;
  /** Stage a file the run needs (for file pickers). Returns the path to pick. */
  stageFile(name: string, data: Uint8Array): Promise<string>;
  /** A live view of the screen for the person, or null when there is none. */
  liveViewUrl(): string | null;
  /** Stop the computer and release it. Safe to call twice. */
  close(): Promise<void>;
}

/** How long an idle computer may live is enforced by its backend. */
export interface ComputerOptions {
  /** Viewport width in pixels. Defaults to 1280. */
  width?: number;
  /** Viewport height in pixels. Defaults to 800. */
  height?: number;
}
