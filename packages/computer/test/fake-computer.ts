import type { ComputerAction } from "../src/actions";
import type { Computer } from "../src/computer";

/** One transparent pixel. Screenshots in tests carry no content. */
export const FAKE_PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

/** A computer that records everything and shows a blank screen. */
export class FakeComputer implements Computer {
  screenshots = 0;
  actions: ComputerAction[][] = [];
  urls: string[] = [];
  staged: Array<{ name: string; data: Uint8Array }> = [];
  closes = 0;
  failOnAct = false;

  constructor(private viewUrl: string | null = null) {}

  async screenshot(): Promise<Uint8Array> {
    this.screenshots += 1;
    return FAKE_PNG;
  }

  async act(actions: ComputerAction[]): Promise<void> {
    if (this.failOnAct) throw new Error("actuator failed");
    this.actions.push(actions);
  }

  async goto(url: string): Promise<void> {
    this.urls.push(url);
  }

  async stageFile(name: string, data: Uint8Array): Promise<string> {
    this.staged.push({ name, data });
    return `/staged/${name}`;
  }

  fileUploadHint(): string {
    return "test picker hint";
  }

  liveViewUrl(): string | null {
    return this.viewUrl;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

export function computerCall(callId: string, actions: ComputerAction[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "computer_call", id: `cc-${callId}`, call_id: callId, actions, pending_safety_checks: [], status: "completed", ...extra };
}

export function assistantMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}
