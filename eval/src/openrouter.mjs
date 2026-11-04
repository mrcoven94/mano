// Meta's open-weight model through OpenRouter's chat API, the route the eval
// uses while the Meta Model API answers 402 (docs/decisions.md, LAP-809). The
// child sends requests in this shape and the parent broker re-applies the pin,
// so a system under test cannot reach an endpoint that keeps data.
// Set MANO_MODEL_PROVIDER=openrouter with OPENROUTER_API_KEY to select it.
// MANO_MODEL_PROVIDER=modal with MODAL_ENDPOINT_URL and MODAL_PROXY_TOKEN selects
// the same open-weight model on a Modal Shared Endpoint, Mail's own route for it.
export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPEN_WEIGHT_MODEL = "meta/muse-spark-open";
export const ZERO_RETENTION = Object.freeze({ zdr: true, data_collection: "deny" });
export const MODAL_MODEL = "meta-models/Muse-Spark-Open-816B-A42B";
const MODAL_USD_PER_TOKEN = { prompt: 1.25e-6, cached: 0.15e-6, completion: 4.25e-6 };
const MODAL_DEFAULT_MAX_TOKENS = 8000;
const BODY_BYTES_PER_TOKEN = 2;
const RESERVED_TOKENS_PER_IMAGE = 3000;
const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const PREFLIGHT_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

// The endpoint's chat URL, or null unless it is https on Modal's own domain.
export function modalChatUrl(env = process.env) {
  try {
    const url = new URL(env.MODAL_ENDPOINT_URL ?? "");
    return url.protocol === "https:" && url.hostname.endsWith(".modal.direct") ? `${url.origin}/v1/chat/completions` : null;
  } catch {
    return null;
  }
}

// The one route selector, read in the parent. The child learns the answer
// over the broker hello because its environment is scrubbed.
export function modelRoute(env = process.env) {
  // Chosen with a setting missing, no model runs: it never falls back to another route.
  if (env.MANO_MODEL_PROVIDER === "modal") return modalChatUrl(env) && env.MODAL_PROXY_TOKEN ? "modal" : null;
  if (env.MANO_MODEL_PROVIDER === "openrouter" && env.OPENROUTER_API_KEY) return "openrouter";
  return env.META_MODEL_API_KEY ? "meta" : null;
}

export function routeLabel(route, date = new Date().toLocaleDateString("en-CA")) {
  if (route === "openrouter") return `live ${OPEN_WEIGHT_MODEL} through OpenRouter, zero-retention endpoints, ${date}, synthetic data`;
  if (route === "modal") return `live ${MODAL_MODEL} on a Modal Shared Endpoint, no per-request retention pin (Modal states zero data retention), ${date}, synthetic data`;
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

// Mail's Modal request: the listed fields with this model, and none of
// OpenRouter's own. Both live systems run at the endpoint's default effort.
// max_tokens is always a real limit, so a call's reservation bounds what it can cost.
export function modalChatBody(body) {
  const { reasoning: _reasoning, ...fields } = picked(body, CHAT_FIELDS);
  const asked = Number(fields.max_tokens);
  return { ...fields, model: MODAL_MODEL, max_tokens: Number.isInteger(asked) && asked > 0 ? asked : MODAL_DEFAULT_MAX_TOKENS };
}

// Modal reports tokens and no price, so the parent prices them at its published rates.
export function modalCostUsd(usage) {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = Math.min(usage?.prompt_tokens_details?.cached_tokens ?? 0, prompt);
  const completion = Math.max(usage?.completion_tokens ?? 0, (usage?.total_tokens ?? 0) - prompt);
  return (prompt - cached) * MODAL_USD_PER_TOKEN.prompt + cached * MODAL_USD_PER_TOKEN.cached + completion * MODAL_USD_PER_TOKEN.completion;
}

// The most one request could cost: every token it allows, and a prompt estimated
// from the body's size. Two bytes per token is more than text takes, but a short
// image URL says nothing about the image, so each image part reserves its own tokens.
export function modalReserveUsd(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const images = messages.flatMap((m) => (Array.isArray(m?.content) ? m.content : [])).filter((part) => part?.type === "image_url").length;
  const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / BODY_BYTES_PER_TOKEN) + images * RESERVED_TOKENS_PER_IMAGE;
  return promptTokens * MODAL_USD_PER_TOKEN.prompt + body.max_tokens * MODAL_USD_PER_TOKEN.completion;
}

// The ceiling, or null unless it is a positive number. Null refuses every Modal
// call: a missing, zero or invalid ceiling never means unlimited.
export function modalCeilingUsd(env = process.env) {
  const raw = env.MANO_EVAL_CEILING_USD;
  const usd = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

// Every Modal call in the parent, the preflight included, passes this meter. Each
// call reserves its worst case before it goes; one with no usage back stays charged at that.
const modalSpend = { calls: 0, promptTokens: 0, completionTokens: 0, spentUsd: 0, reservedUsd: 0, stopped: false };

export function modalSpendReport(env = process.env) {
  return { ...modalSpend, spentUsd: +modalSpend.spentUsd.toFixed(4), reservedUsd: +modalSpend.reservedUsd.toFixed(4), ceilingUsd: modalCeilingUsd(env) };
}

function stopAtCeiling(env) {
  if (modalSpend.stopped) return;
  modalSpend.stopped = true;
  console.error(`CEILING: stopping the run ${JSON.stringify(modalSpendReport(env))}`);
  process.kill(process.pid, "SIGTERM");
}

// The call's reservation, or null when it must not go.
export function admitModalCall(body, env = process.env) {
  const ceiling = modalCeilingUsd(env);
  if (ceiling === null) return null;
  const reserve = modalReserveUsd(body);
  if (modalSpend.stopped || modalSpend.spentUsd + modalSpend.reservedUsd + reserve > ceiling) {
    stopAtCeiling(env);
    return null;
  }
  modalSpend.calls++;
  modalSpend.reservedUsd += reserve;
  return reserve;
}

// Settles one admitted call and returns its price, or null when usage did not say.
// No status means the call failed in transport, and it may still be billed.
export function settleModalCall(reserve, status, usage, env = process.env) {
  let charge = status >= 400 && status < 500 ? 0 : reserve;
  let cost = null;
  if (usage) {
    cost = modalCostUsd(usage);
    charge = cost;
    modalSpend.promptTokens += usage.prompt_tokens ?? 0;
    modalSpend.completionTokens += usage.completion_tokens ?? 0;
  }
  modalSpend.reservedUsd -= reserve;
  modalSpend.spentUsd += charge;
  if (modalSpend.spentUsd >= modalCeilingUsd(env)) stopAtCeiling(env);
  return cost;
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
export async function postChat(body, { fetchImpl = fetch, maxRetries = MAX_RETRIES, delayMs = RETRY_DELAY_MS, deadline, url = OPENROUTER_CHAT_URL } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    if (deadline !== undefined && Date.now() >= deadline) return null;
    try {
      const res = await fetchImpl(url, {
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
  const modal = route === "modal";
  const call = modal
    ? {
        url: modalChatUrl(env),
        key: env.MODAL_PROXY_TOKEN,
        body: modalChatBody({ messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 2000 }),
      }
    : openRouter
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
  const reserve = modal ? admitModalCall(call.body, env) : null;
  if (modal && reserve === null) return { ok: false, status: null };
  let settled = !modal;
  const settle = (status, usage) => {
    if (settled) return;
    settled = true;
    settleModalCall(reserve, status, usage, env);
  };
  try {
    const res = await fetchImpl(call.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${call.key}` },
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      settle(res.status);
      return { ok: false, status: res.status };
    }
    const data = await res.json();
    settle(res.status, data?.usage);
    const usable = openRouter || modal ? chatText(data).length > 0 : Boolean(data?.output_text || data?.output?.length);
    return { ok: usable, status: res.status };
  } catch {
    settle();
    return { ok: false, status: null };
  }
}
