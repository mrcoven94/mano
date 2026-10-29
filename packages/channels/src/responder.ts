// Responder: turns one batch of incoming texts into Mano's reply. Mano's
// voice comes from @mano/persona and goes to the model as instructions;
// the conversation goes as role messages. A turn is one fast call at
// minimal effort that either answers or routes deep with a heads-up,
// which the caller sends at once before the deep call at medium effort.
// When the engine merges, its person agent becomes the Responder behind
// this same interface.
import { DEEP_INSTRUCTIONS, MANO_SOUL, PACING, crisisFloor, isCrisis, routeReply } from "@mano/persona";
import { boundFetch } from "./fetch.js";
import { splitBubbles } from "./bubbles.js";

// The API accepts minimal, low, medium, high, xhigh and max ("none" is
// rejected). Minimal answers a greeting in about 3 s; uncapped
// reasoning took 8 to 30 s for the same reply.
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const FAST_REASONING_EFFORT: ReasoningEffort = "minimal";
export const DEEP_REASONING_EFFORT: ReasoningEffort = "medium";
// Reasoning tokens count against this cap: 600 starved every reply and
// 2048 starved hard questions.
export const MAX_OUTPUT_TOKENS = 8192;
// Defaults for reserving a responder's worst-case turn when it does not
// declare its own: one call of 8192 tokens at roughly 4 characters
// each, plus slack for the instructions.
export const MAX_OUTPUT_CHARS = 32800;
export const INPUT_SLACK_CHARS = 1000;

export interface HistoryMessage {
  role: "person" | "mano";
  text: string;
}

export interface TurnInput {
  texts: string[];
  attachmentCount: number;
  // Earlier messages, oldest first.
  history?: HistoryMessage[];
}

export interface ResponderResult {
  // The raw answer. The worker guards and sanitizes it before splitting,
  // so the bubbles it persists and sends are final.
  text: string;
  bubbles: string[];
  // The largest request's size in characters. Spend multiplies it by
  // attempts, so a two-call turn is never under-counted.
  inputChars: number;
  outputChars: number;
  model: string;
  // Every request attempt across both calls, including retries.
  attempts: number;
}

export interface RespondHooks {
  // Called with the in-voice heads-up when the turn routes deep, before
  // the deep call starts. The responder waits for it, so the heads-up
  // goes out before the long answer is even requested.
  onHeadsUp?(text: string): Promise<void>;
}

export interface Responder {
  readonly name: string;
  // Worst-case attempts for one respond call, for cost reservations.
  readonly maxAttempts: number;
  // Worst-case characters beyond the person's text and history, and of
  // output, for one respond call. Defaults: INPUT_SLACK_CHARS and
  // MAX_OUTPUT_CHARS.
  readonly inputSlackChars?: number;
  readonly maxOutputChars?: number;
  respond(turn: TurnInput, hooks?: RespondHooks): Promise<ResponderResult>;
}

// A failed model call still spent its attempts. The caller settles them.
// The reason is a safe machine string (http status or run status, never
// provider text) so logs can say why without leaking anything.
export class ResponderFailed extends Error {
  readonly attempts: number;
  readonly inputChars: number;
  readonly reason: string;
  constructor(message: string, attempts: number, inputChars: number, reason = "request_error") {
    super(message);
    this.name = "ResponderFailed";
    this.attempts = attempts;
    this.inputChars = inputChars;
    this.reason = reason;
  }
}

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

// The conversation as role messages: the person is the user, Mano is
// the assistant, and the newest texts come last.
export function buildMessages(turn: TurnInput): ModelMessage[] {
  const messages: ModelMessage[] = (turn.history ?? [])
    .filter((h) => h.text.trim().length > 0)
    .map((h) => ({ role: h.role === "person" ? "user" : "assistant", content: h.text }));
  messages.push({ role: "user", content: turn.texts.join("\n") });
  return messages;
}

export function attachmentNote(count: number): string {
  if (count === 0) return "";
  const photos = count === 1 ? "a photo" : `${count} photos`;
  return `\n\nThe person also sent ${photos} with this message. They are saved and will be read separately; acknowledge briefly if you mention them.`;
}

export function extractOutputText(data: unknown): string {
  const output = (data as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const candidate = part as { type?: unknown; text?: unknown } | null;
      if (candidate?.type === "output_text" && typeof candidate.text === "string") {
        parts.push(candidate.text);
      }
    }
  }
  return parts.join("");
}

export interface SparkResponderOptions {
  apiKey: string;
  // The model ID, from config. Production uses a Standard ID; probes
  // and tests on synthetic text use a -contributor ID.
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  hedgeAfterMs?: number;
  reasoningEffort?: ReasoningEffort;
  deepReasoningEffort?: ReasoningEffort;
  fetchFn?: typeof fetch;
  // False when calling through AI Gateway, which would otherwise log
  // prompts and replies. Direct calls have nowhere to opt out of.
  collectLogs?: boolean;
}

export function buildModelBaseUrl(opts: { accountId?: string; gatewayId?: string; provider?: string; directBaseUrl?: string }): {
  url: string;
  via: "ai-gateway" | "direct";
} {
  if (opts.accountId && opts.gatewayId) {
    const provider = opts.provider ?? "meta";
    return { url: `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}/${provider}`, via: "ai-gateway" };
  }
  return { url: (opts.directBaseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, ""), via: "direct" };
}

// The fast call is hedged: an identical second request goes out this
// long after the first, and the first good answer wins. Measured on the
// persona probes: one request's latency runs p50 3.1 s, p90 4.3 s, max
// 5.6 s and tracks reasoning tokens (63 to 338 per reply), with the same
// tail on 30-token prompts; two parallel requests are independent, and
// the faster of a pair stayed under 4.2 s in 12 of 12. The hedge nearly
// always fires, so a fast turn costs about two requests.
export const HEDGE_AFTER_MS = 300;

interface CallResult {
  text: string;
  attempts: number;
  inputChars: number;
}

// A failure no retry can fix: a 4xx or a run that did not complete.
class FatalCall extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export class SparkResponder implements Responder {
  readonly name = "spark";
  // Worst case: the fast call's tries, each hedged, then the deep call's.
  readonly maxAttempts: number;
  readonly inputSlackChars = MANO_SOUL.length + PACING.length + DEEP_INSTRUCTIONS.length + 1000;
  readonly maxOutputChars = 2 * MAX_OUTPUT_CHARS;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private hedgeAfterMs: number;
  private fastEffort: ReasoningEffort;
  private deepEffort: ReasoningEffort;
  private fetchFn: typeof fetch;
  private collectLogs: boolean;

  constructor(opts: SparkResponderOptions) {
    if (!opts.apiKey) throw new Error("A model API key is required.");
    if (!opts.model) throw new Error("A model ID is required.");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 90000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.hedgeAfterMs = opts.hedgeAfterMs ?? HEDGE_AFTER_MS;
    this.fastEffort = opts.reasoningEffort ?? FAST_REASONING_EFFORT;
    this.deepEffort = opts.deepReasoningEffort ?? DEEP_REASONING_EFFORT;
    this.maxAttempts = 3 * (this.maxRetries + 1);
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.collectLogs = opts.collectLogs ?? true;
  }

  async respond(turn: TurnInput, hooks: RespondHooks = {}): Promise<ResponderResult> {
    const messages = buildMessages(turn);
    const note = attachmentNote(turn.attachmentCount);
    // A crisis never waits on a heads-up: no router, and the reply must
    // name 988 and 911.
    const crisis = isCrisis(turn.texts.join("\n"));
    const fast = await this.call(`${MANO_SOUL}${note}${crisis ? "" : `\n\n${PACING}`}`, messages, this.fastEffort, 0, true);
    const route = crisis ? ({ path: "fast", text: fast.text } as const) : routeReply(fast.text);
    if (route.path === "fast") {
      const text = crisis ? crisisFloor(route.text) : route.text;
      return this.result(text, fast.attempts, fast.inputChars);
    }
    await hooks.onHeadsUp?.(route.headsUp);
    const deep = await this.call(
      `${MANO_SOUL}${note}\n\n${DEEP_INSTRUCTIONS}`,
      [...messages, { role: "assistant", content: route.headsUp }],
      this.deepEffort,
      fast.attempts,
      false,
    );
    return this.result(deep.text, fast.attempts + deep.attempts, Math.max(fast.inputChars, deep.inputChars));
  }

  private result(text: string, attempts: number, inputChars: number): ResponderResult {
    return { text, bubbles: splitBubbles(text), inputChars, outputChars: text.length, model: this.model, attempts };
  }

  // One model call, retried on 429, 5xx, network errors and empty
  // answers. Every request sent counts as an attempt, hedges included,
  // and priorAttempts carries the fast call's count into a failed deep
  // call, so a failure still settles everything it spent.
  private async call(
    instructions: string,
    input: ModelMessage[],
    effort: ReasoningEffort,
    priorAttempts: number,
    hedge: boolean,
  ): Promise<CallResult> {
    const inputChars = instructions.length + input.reduce((sum, m) => sum + m.content.length, 0);
    const body = JSON.stringify({ model: this.model, instructions, input, store: false, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort } });
    const sent = { requests: 0 };
    const tries = this.maxRetries + 1;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const text = await this.attempt(body, sent, hedge);
        return { text, attempts: sent.requests, inputChars };
      } catch (err) {
        if (err instanceof FatalCall) throw new ResponderFailed(err.message, priorAttempts + sent.requests, inputChars, err.reason);
        lastErr = err;
        if (attempt < tries) await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : "Model request failed.";
    throw new ResponderFailed(message, priorAttempts + sent.requests, inputChars);
  }

  // One try: a request, plus an identical hedge when the first is slow.
  // The first good answer wins and the other request is aborted.
  private async attempt(body: string, sent: { requests: number }, hedge: boolean): Promise<string> {
    const controllers: AbortController[] = [];
    const launch = (): Promise<string> => {
      const controller = new AbortController();
      controllers.push(controller);
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      sent.requests += 1;
      return this.request(body, controller.signal).finally(() => clearTimeout(timeout));
    };
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = launch();
      const racers = [first];
      if (hedge) {
        const slow = new Promise<boolean>((resolve) => {
          hedgeTimer = setTimeout(() => resolve(true), this.hedgeAfterMs);
        });
        const settled = first.then(
          () => false,
          () => false,
        );
        if (await Promise.race([settled, slow])) racers.push(launch());
      }
      return await Promise.any(racers);
    } catch (err) {
      const errors = err instanceof AggregateError ? err.errors : [err];
      throw errors.find((e) => e instanceof FatalCall) ?? errors[0];
    } finally {
      clearTimeout(hedgeTimer);
      for (const controller of controllers) controller.abort();
    }
  }

  private async request(body: string, signal: AbortSignal): Promise<string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (!this.collectLogs) headers["cf-aig-collect-log"] = "false";
    const res = await this.fetchFn(`${this.baseUrl}/responses`, { method: "POST", signal, headers, body });
    if (res.status !== 429 && res.status < 500 && !res.ok) {
      throw new FatalCall(`http_${res.status}`, `Model request failed: ${res.status}`);
    }
    const data: unknown = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) throw new Error(`Model request failed: ${res.status}`);
    const status = (data as { status?: unknown })?.status;
    if (typeof status === "string" && status !== "completed") throw new FatalCall(`run_${status}`, `Model run ${status}.`);
    const text = extractOutputText(data).trim();
    if (!text) throw new Error("Model returned no text.");
    return text;
  }
}

// Stand-in used when no model key is configured and in tests. Returns
// recorded replies in order so runs work end to end with no key. A
// reply that starts with DEEP: routes deep like the real responder: its
// heads-up goes to onHeadsUp and the next reply is the answer.
const STAND_IN_REPLY = "Thanks for your message. A live answer needs a model key.";

export class StandInResponder implements Responder {
  readonly name = "stand-in";
  readonly maxAttempts = 1;
  prompts: TurnInput[] = [];
  private replies: string[];

  constructor(replies: string[] = []) {
    this.replies = [...replies];
  }

  queueReply(text: string): void {
    this.replies.push(text);
  }

  async respond(turn: TurnInput, hooks: RespondHooks = {}): Promise<ResponderResult> {
    this.prompts.push(turn);
    let text = this.replies.shift() ?? STAND_IN_REPLY;
    const route = routeReply(text);
    if (route.path === "deep") {
      await hooks.onHeadsUp?.(route.headsUp);
      text = this.replies.shift() ?? STAND_IN_REPLY;
    }
    return {
      text,
      bubbles: splitBubbles(text),
      inputChars: JSON.stringify(turn).length,
      outputChars: text.length,
      model: "stand-in",
      attempts: 1,
    };
  }
}
