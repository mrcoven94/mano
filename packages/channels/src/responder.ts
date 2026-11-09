// Responder: turns one batch of incoming texts into Mano's reply. Mano's
// voice comes from @mano/persona and goes to the model as instructions;
// the conversation goes as role messages. A turn is one fast call at
// minimal effort that either answers or routes deep with a heads-up,
// which the caller sends at once before the deep call at medium effort.
// Mano's agent answers behind this same interface (agent.ts), with this
// plain responder as its fallback.
import { DEEP_INSTRUCTIONS, MANO_SOUL, PACING, SAFETY_LINE, crisisLineFor, crisisNote, crisisTurn, routeReply, splitTapback, type Tapback } from "@mano/persona";
import { boundFetch } from "./fetch.js";
import { splitBubbles } from "./bubbles.js";
import { OpenWeightFailed, primaryDownStatus, type OpenWeightAnswer, type OpenWeightFallback } from "./open-weight.js";

const TRAILING_SLASH_RE = /\/$/;

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

// A photo from the turn, stored in the person's Engine documents.
export interface StoredPhoto {
  id: string;
  mimeType: string;
}

export interface TurnInput {
  texts: string[];
  // Photos the person sent with the turn; documents are the ones stored.
  attachmentCount: number;
  documents?: StoredPhoto[];
  // Earlier messages, oldest first.
  history?: HistoryMessage[];
  // The conversation's deletion generation and turn number. Stable across
  // retries and recovery of the same turn, so the agent runs it once.
  turnKey?: { generation: number; turn: number };
  // When Channels received the turn's latest message, on its own clock.
  // The agent orders a YES against the question it answers by this time.
  receivedAtMs?: number;
  // The turn's crisis decision, made once by the worker (decideCrisis).
  // Without it the responder falls back to the keyword floor.
  crisis?: boolean;
  // The texts hold words Mano heard in a voice note.
  spoken?: boolean;
}

// What one model was sent for a turn: requests, the largest request in
// characters (cost multiplies it by requests) and the output it wrote.
export interface ModelUsage {
  model: string;
  requests: number;
  inputChars: number;
  outputChars: number;
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
  // A tapback the model chose for the person's latest message, from a
  // leading "REACT: love" line. The text may then be empty.
  tapback?: Tapback | null;
  // An approval question this answer carries. The runner persists it with
  // the answer and reports it once the bubbles the provider accepted show
  // it whole, retrying the report until it lands.
  presentation?: { approvalId: string; approval: string };
  // Per model, when the turn could use more than one (an open-weight
  // fallback is configured). Without it the turn was one model, and
  // model, attempts, inputChars and outputChars describe it.
  usage?: ModelUsage[];
}

export interface RespondHooks {
  // Called with the in-voice heads-up when the turn routes deep, before
  // the deep call starts. The responder waits for it, so the heads-up
  // goes out before the long answer is even requested.
  onHeadsUp?(text: string): Promise<void>;
}

export interface Responder {
  readonly name: string;
  // The model ID it calls, when it calls one. The voice guard catches a
  // reply that names it.
  readonly model?: string;
  // Worst-case attempts for one respond call, for cost reservations.
  readonly maxAttempts: number;
  // Worst-case characters beyond the person's text and history, and of
  // output, for one respond call. Defaults: INPUT_SLACK_CHARS and
  // MAX_OUTPUT_CHARS.
  readonly inputSlackChars?: number;
  readonly maxOutputChars?: number;
  // True when it reads the turn's stored photos (the agent). Others only
  // hear that a photo came and was not read.
  readonly readsPhotos?: boolean;
  // The words in voice notes already stored, all of them, and whether any
  // note gave none. Others cannot listen at all.
  listen?(notes: StoredPhoto[], generation: number): Promise<{ text: string; missed: boolean }>;
  respond(turn: TurnInput, hooks?: RespondHooks): Promise<ResponderResult>;
}

// A failed model call still spent its attempts. The caller settles them.
// The reason is a safe machine string (http status or run status, never
// provider text) so logs can say why without leaking anything.
export class ResponderFailed extends Error {
  readonly attempts: number;
  readonly inputChars: number;
  readonly reason: string;
  readonly usage?: ModelUsage[];
  constructor(message: string, attempts: number, inputChars: number, reason = "request_error", usage?: ModelUsage[]) {
    super(message);
    this.name = "ResponderFailed";
    this.attempts = attempts;
    this.inputChars = inputChars;
    this.reason = reason;
    this.usage = usage;
  }
}

// What a turn spent, per model: the responder's own breakdown, or one
// entry for a turn that was one model.
export function usageOf(result: ResponderResult): ModelUsage[] {
  return result.usage ?? [{ model: result.model, requests: result.attempts, inputChars: result.inputChars, outputChars: result.outputChars }];
}

export function failedUsageOf(err: ResponderFailed, model: string): ModelUsage[] {
  return err.usage ?? [{ model, requests: err.attempts, inputChars: err.inputChars, outputChars: 0 }];
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
  return `\n\nThe person also sent ${photos} with this message. You cannot see ${count === 1 ? "it" : "them"} and ${count === 1 ? "it was" : "they were"} not read; if you mention ${count === 1 ? "it" : "them"}, say so and ask them to send ${count === 1 ? "it" : "them"} again in a few minutes.`;
}

// Sent without the model for a photo that came alone and was not read
// (no reader answered) or not stored.
export const PHOTO_UNREAD_TEXT = `I could not read your photo just now. Send it again in a few minutes and I will try once more. ${SAFETY_LINE}`;
export const PHOTO_UNSAVED_TEXT = `I could not save your photo, so I have not read it. Please send it again. ${SAFETY_LINE}`;
// Sent when a voice note could not be heard or stored. Nothing is guessed.
export const VOICE_UNHEARD_TEXT = `I could not listen to your voice note just now. Please send it as a text. ${SAFETY_LINE}`;
// Added to the reply when a photo could not be turned into a file an
// office takes (PDF, PNG or JPEG). It can still be read.
export const PHOTO_FORMAT_TEXT = "I could not make a copy of this photo that an office will take, so I cannot attach it to a form. If you want me to send it with one, please send a screenshot of the photo instead.";

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
  // Asked once for a call the primary cannot answer (402, 5xx, timeout,
  // no connection), and for every call while the breaker skips the
  // primary. Without it a failed call fails the turn, as it always has.
  openWeight?: OpenWeightFallback;
}

export function buildModelBaseUrl(opts: { accountId?: string; gatewayId?: string; provider?: string; directBaseUrl?: string }): {
  url: string;
  via: "ai-gateway" | "direct";
} {
  if (opts.accountId && opts.gatewayId) {
    const provider = opts.provider ?? "meta";
    return { url: `https://gateway.ai.cloudflare.com/v1/${opts.accountId}/${opts.gatewayId}/${provider}`, via: "ai-gateway" };
  }
  return { url: (opts.directBaseUrl ?? "https://api.meta.ai/v1").replace(TRAILING_SLASH_RE, ""), via: "direct" };
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
  model: string;
}

// Why one request failed: whether another try may help, and whether it
// means the primary is down for this call.
class CallFailed extends Error {
  readonly reason: string;
  readonly retry: boolean;
  readonly down: boolean;
  constructor(reason: string, message: string, retry: boolean, down: boolean) {
    super(message);
    this.reason = reason;
    this.retry = retry;
    this.down = down;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function callFailed(err: unknown): CallFailed {
  return err instanceof CallFailed ? err : new CallFailed("request_error", err instanceof Error ? err.message : "Model request failed.", true, false);
}

// Requests per model across one turn, for cost per model.
class UsageTally {
  private byModel = new Map<string, ModelUsage>();

  add(model: string, requests: number, inputChars: number): void {
    if (requests === 0) return;
    const u = this.byModel.get(model) ?? { model, requests: 0, inputChars: 0, outputChars: 0 };
    this.byModel.set(model, { ...u, requests: u.requests + requests, inputChars: Math.max(u.inputChars, inputChars) });
  }

  wrote(model: string, outputChars: number): void {
    const u = this.byModel.get(model);
    if (u) this.byModel.set(model, { ...u, outputChars: u.outputChars + outputChars });
  }

  get requests(): number {
    return [...this.byModel.values()].reduce((sum, u) => sum + u.requests, 0);
  }

  get inputChars(): number {
    return Math.max(0, ...[...this.byModel.values()].map((u) => u.inputChars));
  }

  list(): ModelUsage[] {
    return [...this.byModel.values()];
  }
}

export class SparkResponder implements Responder {
  readonly name = "spark";
  // Worst case: the fast call's tries, each hedged, then the deep call's,
  // plus one fallback request per call when there is a fallback.
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
  private openWeight?: OpenWeightFallback;

  constructor(opts: SparkResponderOptions) {
    if (!opts.apiKey) throw new Error("A model API key is required.");
    if (!opts.model) throw new Error("A model ID is required.");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.meta.ai/v1").replace(TRAILING_SLASH_RE, "");
    this.timeoutMs = opts.timeoutMs ?? 90000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.hedgeAfterMs = opts.hedgeAfterMs ?? HEDGE_AFTER_MS;
    this.fastEffort = opts.reasoningEffort ?? FAST_REASONING_EFFORT;
    this.deepEffort = opts.deepReasoningEffort ?? DEEP_REASONING_EFFORT;
    this.openWeight = opts.openWeight;
    this.maxAttempts = 3 * (this.maxRetries + 1) + (this.openWeight ? 2 : 0);
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.collectLogs = opts.collectLogs ?? true;
  }

  async respond(turn: TurnInput, hooks: RespondHooks = {}): Promise<ResponderResult> {
    const messages = buildMessages(turn);
    const note = attachmentNote(turn.attachmentCount);
    const tally = new UsageTally();
    // A crisis never waits on a heads-up: no router. finalizeReply sends
    // the crisis line first on every path, so the model is told it is
    // already there and writes the human part (safety-05).
    const text = turn.texts.join("\n");
    const crisis = turn.crisis ?? crisisTurn(text);
    const fast = await this.call(
      `${MANO_SOUL}${note}${crisis ? `\n\n${crisisNote(crisisLineFor(text))}` : `\n\n${PACING}`}`,
      messages,
      this.fastEffort,
      tally,
      true,
    );
    const route = crisis ? ({ path: "fast", text: fast.text } as const) : routeReply(fast.text);
    if (route.path === "fast") {
      return this.result(route.text, fast.model, tally);
    }
    await hooks.onHeadsUp?.(route.headsUp);
    const deep = await this.call(
      `${MANO_SOUL}${note}\n\n${DEEP_INSTRUCTIONS}`,
      [...messages, { role: "assistant", content: route.headsUp }],
      this.deepEffort,
      tally,
      false,
    );
    return this.result(deep.text, deep.model, tally);
  }

  private result(raw: string, model: string, tally: UsageTally): ResponderResult {
    tally.wrote(model, raw.length);
    const { tapback, text } = splitTapback(raw);
    const result: ResponderResult = { text, bubbles: splitBubbles(text), inputChars: tally.inputChars, outputChars: raw.length, model, attempts: tally.requests, tapback };
    if (this.openWeight) result.usage = tally.list();
    return result;
  }

  // One model call. The primary is retried on 429, 5xx, network errors
  // and empty answers; with a fallback, a timeout is not waited on twice.
  // When the primary is down (402, 5xx, timeout, no connection) the
  // fallback is asked once and the breaker skips the primary for a while.
  // Every request sent counts, hedges included, and the tally carries the
  // fast call's requests into a failed deep call, so a failure still
  // settles everything it spent.
  private async call(instructions: string, input: ModelMessage[], effort: ReasoningEffort, tally: UsageTally, hedge: boolean): Promise<CallResult> {
    const inputChars = instructions.length + input.reduce((sum, m) => sum + m.content.length, 0);
    const openWeight = this.openWeight;
    if (openWeight?.breaker.skipPrimary()) return this.askOpenWeight(openWeight, instructions, input, effort, inputChars, tally, "skipped");
    const body = JSON.stringify({ model: this.model, instructions, input, store: false, max_output_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort } });
    const sent = { requests: 0 };
    const tries = this.maxRetries + 1;
    let failure = new CallFailed("request_error", "Model request failed.", true, false);
    try {
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          return { text: await this.attempt(body, sent, hedge), model: this.model };
        } catch (err) {
          failure = callFailed(err);
          if (!failure.retry || (failure.reason === "timeout" && openWeight)) break;
          if (attempt < tries) await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
        }
      }
    } finally {
      tally.add(this.model, sent.requests, inputChars);
    }
    if (openWeight && failure.down) {
      openWeight.breaker.trip();
      return this.askOpenWeight(openWeight, instructions, input, effort, inputChars, tally, failure.reason);
    }
    throw new ResponderFailed(failure.message, tally.requests, inputChars, failure.reason, openWeight ? tally.list() : undefined);
  }

  private async askOpenWeight(
    openWeight: OpenWeightFallback,
    instructions: string,
    input: ModelMessage[],
    effort: ReasoningEffort,
    inputChars: number,
    tally: UsageTally,
    primaryReason: string,
  ): Promise<CallResult> {
    const { client } = openWeight;
    tally.add(client.model, 1, inputChars);
    const fail = (reason: string) =>
      new ResponderFailed("The model and its fallback failed.", tally.requests, inputChars, `primary_${primaryReason},fallback_${reason}`, tally.list());
    let answer: OpenWeightAnswer;
    try {
      answer = await client.ask({ instructions, input, maxTokens: MAX_OUTPUT_TOKENS, effort });
    } catch (err) {
      throw fail(err instanceof OpenWeightFailed ? err.reason : "request_error");
    }
    if (!answer.complete) throw fail("incomplete");
    if (!answer.text) throw fail("empty");
    return { text: answer.text, model: client.model };
  }

  // One try: a request, plus an identical hedge when the first is slow.
  // The first good answer wins and the other request is aborted.
  private async attempt(body: string, sent: { requests: number }, hedge: boolean): Promise<string> {
    const controllers: AbortController[] = [];
    const launch = (): Promise<string> => {
      const controller = new AbortController();
      controllers.push(controller);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      sent.requests += 1;
      return this.request(body, controller.signal)
        .catch((err: unknown) => {
          throw timedOut ? new CallFailed("timeout", "Model request timed out.", true, true) : err;
        })
        .finally(() => clearTimeout(timeout));
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
      throw errors.find((e) => e instanceof CallFailed && !e.retry) ?? errors[0];
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
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/responses`, { method: "POST", signal, headers, body });
    } catch (err) {
      throw new CallFailed("network", err instanceof Error ? err.message : "Model request failed.", true, true);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const retry = res.status === 429 || res.status >= 500;
      throw new CallFailed(`http_${res.status}`, `Model request failed: ${res.status}`, retry, primaryDownStatus(res.status));
    }
    // A connection lost while the body streams in is a failed connection,
    // as if it never connected. A whole body that is not JSON is no answer.
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      throw new CallFailed("network", err instanceof Error ? err.message : "Model response was cut off.", true, true);
    }
    const data = parseJson(raw);
    const status = (data as { status?: unknown })?.status;
    if (typeof status === "string" && status !== "completed") throw new CallFailed(`run_${status}`, `Model run ${status}.`, false, false);
    const text = extractOutputText(data).trim();
    if (!text) throw new CallFailed("empty", "Model returned no text.", true, false);
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
    const split = splitTapback(text);
    text = split.text;
    return {
      tapback: split.tapback,
      text,
      bubbles: splitBubbles(text),
      inputChars: JSON.stringify(turn).length,
      outputChars: text.length,
      model: "stand-in",
      attempts: 1,
    };
  }
}
