/**
 * Computer use on Meta's open-weight model through OpenRouter, for while the
 * Meta Model API cannot answer (AGENTS.md rule 7, docs/decisions.md). Same
 * ModelClient as the Meta path, so runLoop runs both the same way.
 *
 * The open model has no hosted computer tool: OpenRouter lists no native tools
 * for it, so the Meta path's computer_call never comes back. It takes images
 * and calls functions, so this client offers the action vocabulary as one
 * function and turns each call into the computer_call the loop expects. A
 * reply is accepted whole or not at all: it must say it completed, hold only
 * items this path offers, and every call and action in it must parse.
 *
 * The model, the zero-retention pin and the OpenRouter endpoint are constants.
 * The one other place this client can send a screenshot is a Modal Shared
 * Endpoint serving the same model, named by modalUrl and held to Modal's domain.
 * Rule 7 does not list that route, so it carries synthetic data only until
 * David changes that rule. This path never raises a safety check: there is no hosted
 * tool to raise one. What holds instead is this parser, the loop's closed list
 * of keys and buttons, and the desktop, which binds no window manager keys and
 * reaches only the portal, whose browser pages save drafts and file nothing.
 */
import { isComputerCall, type ComputerAction, type ComputerCall } from "./actions";
import { FetchModelClient, type ModelClient, type ResponsePayload, type ResponseRequest } from "./model";

export const OPEN_WEIGHT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPEN_WEIGHT_MODEL_ID = "meta/muse-spark-open";

const OPEN_WEIGHT_BODY = Object.freeze({
  // Only endpoints with zero data retention, and no provider that stores or
  // trains on what it is sent. Among those, the fastest to answer: a fill has
  // 60 seconds, and the reply still has to go out after it.
  provider: Object.freeze({ sort: "latency", zdr: true, data_collection: "deny" }),
  reasoning: Object.freeze({ effort: "low" }),
  max_output_tokens: 4096,
});

export const MODAL_MODEL_ID = "meta-models/Muse-Spark-Open-816B-A42B";

// Modal has no per-request routing to pin: its security page says Shared
// Endpoints keep no request or response payloads.
const MODAL_BODY = Object.freeze({
  reasoning: OPEN_WEIGHT_BODY.reasoning,
  max_output_tokens: OPEN_WEIGHT_BODY.max_output_tokens,
});

function modalApiRoot(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".modal.direct")) throw new Error("this path reaches Modal only on its own endpoint domain");
  return `${url.origin}/v1`;
}

const TOOL_NAME = "computer";
// Both backends' default, and fills never change it.
const SCREEN = Object.freeze({ width: 1280, height: 800 });
// The model aims on a 0 to 1000 grid, whatever it is told: asked for pixels on
// a 1280 by 800 screen, it clicked a field centred at (291, 79) at (227, 98),
// which landed each value one field too low. So the tool states the grid and
// this file converts, in both directions, since a call replays as it was made.
const GRID = 1000;
const toPixel = (value: number, size: number): number => Math.min(size - 1, Math.round((value * size) / GRID));
const toGrid = (value: number, size: number): number => Math.round((value * GRID) / size);
// Far past any form, and short of the thousands of wheel clicks a huge value
// would queue on the desktop.
const MAX_SCROLL = 5000;

// Forms need no dragging, hovering or other mouse buttons, so the model is not
// offered them.
const COMPUTER_TOOL = Object.freeze({
  type: "function",
  name: TOOL_NAME,
  description:
    "Act on the browser: runs these actions in order, then you are shown the new screen. x and y are on a grid from 0 to 1000 across and down the screen, with (0, 0) at the top-left, whatever the screen's size.",
  parameters: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["click", "double_click", "type", "keypress", "scroll", "wait", "screenshot"] },
            x: { type: "number", description: "For click, double_click and scroll." },
            y: { type: "number", description: "For click, double_click and scroll." },
            text: { type: "string", description: "For type." },
            keys: { type: "array", items: { type: "string" }, description: 'For keypress, pressed together, such as ["ctrl", "a"].' },
            scroll_x: { type: "number", description: "For scroll, in pixels." },
            scroll_y: { type: "number", description: "For scroll, in pixels." },
          },
          required: ["type"],
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  },
});

// Every failure below is a fixed string: what the model sent can echo the
// person's values, and errors get logged. Keys are checked by the loop, which
// holds the list for both model paths.
function parseAction(raw: unknown): ComputerAction {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const within = (value: unknown, min: number, max: number): number => {
    if (typeof value !== "number" || !(value >= min && value <= max)) throw new Error("the model sent an action with a bad coordinate");
    return Math.round(value);
  };
  const point = () => ({ x: toPixel(within(a["x"], 0, GRID), SCREEN.width), y: toPixel(within(a["y"], 0, GRID), SCREEN.height) });
  switch (a["type"]) {
    case "click":
      // Never run a right click as a left one.
      if (a["button"] !== undefined && a["button"] !== "left") throw new Error("the model sent a click with a button the computer tool does not have");
      return { type: "click", button: "left", ...point() };
    case "double_click":
      return { type: "double_click", ...point() };
    case "scroll":
      return { type: "scroll", ...point(), scroll_x: within(a["scroll_x"] ?? 0, -MAX_SCROLL, MAX_SCROLL), scroll_y: within(a["scroll_y"] ?? 0, -MAX_SCROLL, MAX_SCROLL) };
    case "type":
      if (typeof a["text"] !== "string") throw new Error("the model sent a type action with no text");
      return { type: "type", text: a["text"] };
    case "keypress": {
      const keys = a["keys"];
      if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string")) throw new Error("the model sent a keypress with no keys");
      return { type: "keypress", keys: keys as string[] };
    }
    case "wait":
      return { type: "wait" };
    case "screenshot":
      return { type: "screenshot" };
    default:
      throw new Error("the model sent an action the computer tool does not have");
  }
}

interface FunctionCall {
  call_id: string;
  actions: ComputerAction[];
}

// Every call in the reply is checked before any of them runs. OpenRouter's
// schema leaves a call's status optional, so only a status that is present
// and says otherwise is refused.
function parseCall(item: Record<string, unknown>): FunctionCall {
  const { call_id: callId, name, status } = item;
  if (typeof callId !== "string" || callId === "") throw new Error("the model sent a call with no id");
  if (status !== undefined && status !== "completed") throw new Error("the model sent a call that did not complete");
  if (name !== TOOL_NAME) throw new Error("the model called a function that does not exist");
  let args: unknown;
  try {
    args = JSON.parse(String(item["arguments"]));
  } catch {
    throw new Error("the model sent arguments that are not JSON");
  }
  const actions = (args as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) throw new Error("the model sent no actions");
  return { call_id: callId, actions: actions.map(parseAction) };
}

// A closed list: anything else in a reply is a tool this path never offered,
// a native computer_call included, and its actions were never checked.
const REPLY_ITEMS = new Set(["function_call", "message", "reasoning"]);

// The loop runs one computer_call a turn, and a function call left unanswered
// would be refused on replay, so calls made together become one batch.
function fromOpenWeight(output: unknown[]): unknown[] {
  const items = output.map((item) => (typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {}));
  if (items.some((item) => typeof item["type"] !== "string" || !REPLY_ITEMS.has(item["type"]))) throw new Error("the model's reply holds something this path does not offer");
  const calls = items.filter((item) => item["type"] === "function_call").map(parseCall);
  const first = calls[0];
  if (!first) return output;
  const call: ComputerCall = {
    type: "computer_call",
    id: first.call_id,
    call_id: first.call_id,
    actions: calls.flatMap((c) => c.actions),
    pending_safety_checks: [],
    status: "completed",
  };
  return [call];
}

// OpenRouter's request schema requires detail on every image. High, because
// the model picks points on this screen.
function screen(imageUrl: unknown) {
  return { type: "input_image", detail: "high", image_url: imageUrl };
}

// A screenshot goes back in a user message, where OpenRouter documents image
// input: a provider may flatten a function's result to text, which would
// leave the model blind and still clicking.
function toOpenWeight(input: unknown[]): unknown[] {
  return input.flatMap((item) => {
    if (isComputerCall(item)) {
      const actions = item.actions.map((a) => ("x" in a && "y" in a ? { ...a, x: toGrid(a.x, SCREEN.width), y: toGrid(a.y, SCREEN.height) } : a));
      return [{ type: "function_call", call_id: item.call_id, name: TOOL_NAME, arguments: JSON.stringify({ actions }) }];
    }
    const entry = item as { role?: unknown; content?: unknown; type?: unknown; call_id?: unknown; output?: { image_url?: unknown } };
    if (entry.type === "computer_call_output") {
      return [
        { type: "function_call_output", call_id: entry.call_id, output: "Done. The next message shows the screen now." },
        { role: "user", content: [screen(entry.output?.image_url)] },
      ];
    }
    if (!Array.isArray(entry.content)) return [item];
    const content = entry.content.map((part: { type?: unknown; image_url?: unknown }) => (part.type === "input_image" ? screen(part.image_url) : part));
    return [{ ...entry, content }];
  });
}

export interface OpenWeightModelOptions {
  apiKey: string;
  /** A Modal Shared Endpoint's URL, with apiKey as its proxy token. Without one, OpenRouter. */
  modalUrl?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export class OpenWeightModelClient implements ModelClient {
  private inner: FetchModelClient;
  private modelId: string;

  constructor({ modalUrl, ...options }: OpenWeightModelOptions) {
    this.modelId = modalUrl ? MODAL_MODEL_ID : OPEN_WEIGHT_MODEL_ID;
    this.inner = modalUrl
      ? new FetchModelClient({ ...options, baseUrl: modalApiRoot(modalUrl), body: MODAL_BODY })
      : new FetchModelClient({ ...options, baseUrl: OPEN_WEIGHT_BASE_URL, body: OPEN_WEIGHT_BODY });
  }

  async createResponse(request: ResponseRequest): Promise<ResponsePayload> {
    if (request.model !== this.modelId) throw new Error("this path runs only Meta's open-weight model");
    const response = await this.inner.createResponse({ ...request, tools: [COMPUTER_TOOL], input: toOpenWeight(request.input), store: false });
    // Failed, cut off by the output cap, or no status at all: nothing in it runs.
    if (response.status !== "completed") throw new Error("the model's reply did not complete");
    return { ...response, output: fromOpenWeight(response.output) };
  }
}
