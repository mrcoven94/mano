/** The computer-use action vocabulary. Coordinates are pixels in the last screenshot sent. */

export type ComputerAction =
  | { type: "click"; button: "left" | "right" | "wheel" | "back" | "forward"; x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; path: Array<{ x: number; y: number }> }
  | { type: "keypress"; keys: string[] }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: "type"; text: string }
  | { type: "screenshot" }
  | { type: "wait" };

export interface SafetyCheck {
  id: string;
  code: string;
  message: string;
}

/** One computer_call output item from the model. Unknown fields ride through for replay. */
export interface ComputerCall {
  type: "computer_call";
  id: string;
  call_id: string;
  actions: ComputerAction[];
  pending_safety_checks: SafetyCheck[];
  status: string;
  [key: string]: unknown;
}

export function isComputerCall(item: unknown): item is ComputerCall {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  return candidate["type"] === "computer_call" && Array.isArray(candidate["actions"]) && typeof candidate["call_id"] === "string";
}

/** Pull the assistant's final text out of a Responses output list. */
export function outputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const content = record["content"];
    if (record["type"] === "message" && Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const text = (block as Record<string, unknown>)["text"];
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
}
