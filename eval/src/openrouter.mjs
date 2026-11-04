// Meta's open-weight model through OpenRouter's chat API, the route the eval
// uses while the Meta Model API answers 402 (docs/decisions.md, LAP-809). The
// child sends requests in this shape and the parent broker re-applies the pin,
// so a system under test cannot reach an endpoint that keeps data.
// Set MANO_MODEL_PROVIDER=openrouter with OPENROUTER_API_KEY to select it.
export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPEN_WEIGHT_MODEL = "meta/muse-spark-open";
export const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: "deny" });
const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const PREFLIGHT_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

// The one route selector, read in the parent. The child learns the answer
// over the broker hello because its environment is scrubbed.
export function modelRoute(env = process.env) {
  if (env.MANO_MODEL_PROVIDER === "openrouter" && env.OPENROUTER_API_KEY) return "openrouter";
  return env.META_MODEL_API_KEY ? "meta" : null;
}

export function routeLabel(route, date = new Date().toLocaleDateString("en-CA")) {
  if (route === "openrouter") return `live ${OPEN_WEIGHT_MODEL} through OpenRouter, zero-retention endpoints, ${date}, synthetic data`;
  if (route === "meta") return `live Meta Model API, muse-spark-1.3-contributor, ${date}, synthetic data`;
  return "offline (no model key)";
}

// Only these fields leave the parent. Listing them keeps out OpenRouter's other
// ways to pick a model or a route, such as "models" and "route".
const CHAT_FIELDS = ["messages", "tools", "tool_choice", "max_tokens", "reasoning", "response_format"];
const PROVIDER_FIELDS = ["sort", "require_parameters"];

function picked(from, fields) {
  const out = {};
  for (const k of fields) if (from && from[k] !== undefined) out[k] = from[k];
  return out;
}

// Fixes the model, the pin and usage reporting on any request body. Applied
// last in the parent, so nothing the child sends can change them.
export function pinnedChatBody(body) {
  return {
    ...picked(body, CHAT_FIELDS),
    model: OPEN_WEIGHT_MODEL,
    provider: { ...picked(body?.provider, PROVIDER_FIELDS), ...ZERO_RETENTION },
    usage: { include: true },
  };
}

function chatPart(part) {
  if (part.type === "input_image") {
    return { type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
  }
  return { type: "text", text: part.text };
}

// Responses-style input (a string, messages, function calls and their
// outputs) as chat messages. Calls in a row belong to one assistant message.
export function toChatMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const messages = [];
  for (const item of input) {
    if (item.type === "function_call") {
      const last = messages[messages.length - 1];
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } };
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    } else if (item.role === "system" || item.role === "developer") {
      messages.push({ role: "system", content: item.content.map((c) => c.text).join("\n") });
    } else {
      messages.push({ role: "user", content: item.content.map(chatPart) });
    }
  }
  return messages;
}

export function toChatTool(tool) {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

export function chatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export function chatCalls(data) {
  const calls = data?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((c) => ({ callId: c.id, name: c.function?.name, args: c.function?.arguments }));
}

function retryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

// One chat call with bounded retries for load and transport failures. Returns
// the parsed body, or null once retries run out or the status is final.
// A body with an error and no choices counts as a failed attempt.
export async function postChat(body, { fetchImpl = fetch, maxRetries = MAX_RETRIES, delayMs = RETRY_DELAY_MS, deadline } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    if (deadline !== undefined && Date.now() >= deadline) return null;
    try {
      const res = await fetchImpl(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // The broker aborts the request itself when this runs out.
        ...(deadline !== undefined ? { timeoutMs: Math.max(1, deadline - Date.now()) } : {}),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.choices) && data.choices.length > 0) return data;
      } else if (!retryable(res.status)) {
        return null;
      }
    } catch {
      // A transport failure or broker timeout: try again within the bound.
    }
  }
  return null;
}

// One tiny call before a held-out run, so an account problem stops the run
// instead of scoring every household as a failure. A provider that runs out
// mid-run shows up in the report's model call failures. Only a usable answer
// passes: an error body can come back with status 200.
export async function preflight(route, { env = process.env, fetchImpl = fetch, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  if (route === null) return { ok: true, status: null };
  const openRouter = route === "openrouter";
  const call = openRouter
    ? {
        url: OPENROUTER_CHAT_URL,
        key: env.OPENROUTER_API_KEY,
        body: pinnedChatBody({ messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 2000 }),
      }
    : {
        url: META_RESPONSES_URL,
        key: env.META_MODEL_API_KEY,
        body: { model: "muse-spark-1.3-contributor", store: false, input: "Reply with the word ok.", max_output_tokens: 2000 },
      };
  try {
    const res = await fetchImpl(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${call.key}` },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    const usable = openRouter ? chatText(data).length > 0 : Boolean(data?.output_text || data?.output?.length);
    return { ok: usable, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}
