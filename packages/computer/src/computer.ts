import type { ComputerAction } from "./actions";

/** A desktop with a browser, worked through screenshots, mouse and keyboard. */
export interface Computer {
  /** Capture the current screen as PNG bytes. Size must stay stable across a run. */
  screenshot(): Promise<Uint8Array>;
  /** Run one batch of actions in order. Stops early if an action fails. */
  act(actions: ComputerAction[]): Promise<void>;
  /** Open a page on the allowed portal origin. Every other origin is refused. */
  goto(url: string): Promise<void>;
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
