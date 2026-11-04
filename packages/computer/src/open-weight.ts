/**
 * Computer use on Meta's open-weight model through OpenRouter, for while the
 * Meta Model API cannot answer (AGENTS.md rule 7, docs/decisions.md). Same
 * ModelClient as the Meta path, so runLoop does not change.
 *
 * The open model has no hosted computer tool: OpenRouter lists no native tools
 * for it, so the Meta path's computer_call never comes back. It takes images
 * and calls functions, so this client offers the action vocabulary as one
 * function and turns each call into the computer_call the loop expects.
 *
 * Nothing but the API key is an option here. The model, the zero-retention
 * pin and the endpoint are constants, so this client cannot send a screenshot
 * anywhere else. This path never raises a safety check: there is no hosted
 * tool to raise one, so the desktop's own limits are the only ones that hold
 * (it reaches only the portal, whose browser pages save drafts and file nothing).
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

const TOOL_NAME = "computer";

// Forms need no dragging, hovering or other mouse buttons, so the model is not
// offered them. The size is both backends' default, and fills never change it.
const COMPUTER_TOOL = Object.freeze({
  type: "function",
  name: TOOL_NAME,
  description:
    "Act on the browser: runs these actions in order, then you are shown the new screen. The screen is 1280 by 800 pixels. x and y are pixels on it, with (0, 0) at the top-left, never fractions or a scaled grid.",
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
// person's values, and errors get logged.
function parseAction(raw: unknown): ComputerAction {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pixel = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("the model sent an action with a bad coordinate");
    return Math.round(value);
  };
  switch (a["type"]) {
    case "click":
      return { type: "click", button: "left", x: pixel(a["x"]), y: pixel(a["y"]) };
    case "double_click":
      return { type: "double_click", x: pixel(a["x"]), y: pixel(a["y"]) };
    case "scroll":
      return { type: "scroll", x: pixel(a["x"]), y: pixel(a["y"]), scroll_x: pixel(a["scroll_x"] ?? 0), scroll_y: pixel(a["scroll_y"] ?? 0) };
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
  name?: unknown;
  arguments?: unknown;
}

function isFunctionCall(item: unknown): item is FunctionCall {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  return candidate["type"] === "function_call" && typeof candidate["call_id"] === "string";
}

function actionsOf(call: FunctionCall): ComputerAction[] {
  if (call.name !== TOOL_NAME) throw new Error("the model called a function that does not exist");
  let args: unknown;
  try {
    args = JSON.parse(String(call.arguments));
  } catch {
    throw new Error("the model sent arguments that are not JSON");
  }
  const actions = (args as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) throw new Error("the model sent no actions");
  return actions.map(parseAction);
}

// The loop runs one computer_call a turn, and a function call left unanswered
// would be refused on replay, so calls made together become one batch.
function fromOpenWeight(output: unknown[]): unknown[] {
  const calls = output.filter(isFunctionCall);
  const first = calls[0];
  if (!first) return output;
  const call: ComputerCall = {
    type: "computer_call",
    id: first.call_id,
    call_id: first.call_id,
    actions: calls.flatMap(actionsOf),
    pending_safety_checks: [],
    status: "completed",
  };
  return [call];
}

// OpenRouter's request schema requires detail on every image. High, because
// the model picks pixels on this screen.
function screen(imageUrl: unknown) {
  return { type: "input_image", detail: "high", image_url: imageUrl };
}

// A screenshot goes back in a user message, where OpenRouter documents image
// input: a provider may flatten a function's result to text, which would
// leave the model blind and still clicking.
function toOpenWeight(input: unknown[]): unknown[] {
  return input.flatMap((item) => {
    if (isComputerCall(item)) {
      return [{ type: "function_call", call_id: item.call_id, name: TOOL_NAME, arguments: JSON.stringify({ actions: item.actions }) }];
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
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export class OpenWeightModelClient implements ModelClient {
  private inner: FetchModelClient;

  constructor(options: OpenWeightModelOptions) {
    this.inner = new FetchModelClient({ ...options, baseUrl: OPEN_WEIGHT_BASE_URL, body: OPEN_WEIGHT_BODY });
  }

  async createResponse(request: ResponseRequest): Promise<ResponsePayload> {
    if (request.model !== OPEN_WEIGHT_MODEL_ID) throw new Error("this path runs only Meta's open-weight model");
    const response = await this.inner.createResponse({ ...request, tools: [COMPUTER_TOOL], input: toOpenWeight(request.input), store: false });
    // Cut off by the output cap: a half-written batch must not run.
    if (response.status === "incomplete") throw new Error("the model stopped before finishing its reply");
    return { ...response, output: fromOpenWeight(response.output) };
  }
}
