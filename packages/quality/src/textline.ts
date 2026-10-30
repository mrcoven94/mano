// The real text line as an answer path: the production SparkResponder with
// Mano's voice from @mano/persona, then finalizeReply from @mano/channels,
// the same function the worker runs on every reply before it is sent
// (voice guard, link check against the Cloudflare resolvers, bubble split
// and cap, and the crisis line first on a crisis turn). The worker's turn
// logic around it (opt-out, the crisis decision, an empty reply with a
// tapback, the heads-up check) is mirrored from apps/channels/src/runner.ts.

import {
  isOptOut,
  finalizeReply,
  LinkChecker,
  OPT_OUT_BUBBLE,
  ResponderFailed,
  SparkResponder,
  type Responder,
  stripBlockedLinks,
  type HistoryMessage,
} from "@mano/channels";
import { NEEDS_ANSWER_TEXT, allowedTapback, crisisLineFor, crisisTurn, guardReply, needsAnswer, refusedReactionText, tapbackText, type GuardChange } from "@mano/persona";
import { viaAiGateway } from "./models.ts";
import type { AnswerPath, BenchAnswer } from "./paths.ts";
import type { BenchCase } from "./suites/types.ts";

// Who wrote a case's answers: the agent on every turn, the plain fallback on
// every turn, a mix, the plain line with no agent, or the worker itself
// (STOP, which no responder sees).
export type ServedBy = "agent" | "fallback" | "mixed" | "plain" | "worker";

export function combineServedBy(labels: (ServedBy | undefined)[]): ServedBy {
  const seen = new Set(labels.filter((l): l is ServedBy => l !== undefined && l !== "worker"));
  if (seen.size === 0) return labels.includes("worker") ? "worker" : "plain";
  if (seen.has("mixed") || (seen.has("agent") && seen.has("fallback"))) return "mixed";
  return [...seen][0]!;
}

export interface TurnRun {
  route: "fast" | "deep";
  // "agent" when Mano's agent answered, "fallback" when the agent responder
  // fell back to the plain answer, "plain" with no agent in the path.
  servedBy?: ServedBy;
  // The heads-up as sent on a deep turn, after the guard and link check.
  headsUp: string | null;
  // The answer bubbles as sent.
  bubbles: string[];
  // Time to the first text the person sees: the heads-up on a deep turn.
  firstTextMs: number;
  totalMs: number;
  guardChanges: GuardChange[];
  linksRemoved: number;
  attempts: number;
  // Characters billed: every request attempt's input, plus the output.
  billedInputChars: number;
  outputChars: number;
}

export interface TextLineOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function sparkResponder(opts: TextLineOptions): SparkResponder {
  return new SparkResponder({
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    // Through AI Gateway, no request or reply is logged.
    collectLogs: !viaAiGateway(opts.baseUrl ?? ""),
  });
}

// Synthetic bench text may go to a -contributor ID; the judge never does.
// The responder is the plain model answer by default, or the agent with the
// plain answer as its fallback (agent.ts).
export class TextLine {
  readonly model: string;
  private responder: Responder;
  private fetchFn: typeof fetch | undefined;
  private turnNumber = 0;

  constructor(opts: TextLineOptions & { responder?: Responder }) {
    this.model = opts.model;
    this.fetchFn = opts.fetchFn;
    this.responder = opts.responder ?? sparkResponder(opts);
  }

  // `at` fixes the turn's key and receive time, so a retry of the same turn
  // reaches the agent as the same turn, as Channels' recovery does.
  async turn(texts: string[], history: HistoryMessage[], attachmentCount = 0, at?: { turn: number; receivedAtMs: number }): Promise<TurnRun> {
    // The worker answers STOP and its kin itself, before any model call.
    if (texts.length === 1 && attachmentCount === 0 && isOptOut(texts[0]!)) {
      return { servedBy: "worker", route: "fast", headsUp: null, bubbles: [OPT_OUT_BUBBLE], firstTextMs: 0, totalMs: 0, guardChanges: [], linksRemoved: 0, attempts: 0, billedInputChars: 0, outputChars: 0 };
    }
    const turnText = texts.join("\n");
    // The worker's crisis decision: the broad detector, minus an exact
    // benefits cut ("they cut my food stamps").
    const crisis = crisisTurn(turnText);
    const modelIds = [this.model];
    const changes: GuardChange[] = [];
    const guard = (text: string): string => {
      const out = guardReply(text, { modelIds });
      changes.push(...out.changes);
      return out.text;
    };
    const checker = new LinkChecker(this.fetchFn ? { fetchFn: this.fetchFn } : {});
    let removed = 0;
    let headsUp: string | null = null;
    let headsUpAt: number | null = null;
    const started = performance.now();
    let result;
    try {
      // The agent runs a turn only with a stable turn key, as Channels sends.
      const key = at ?? { turn: ++this.turnNumber, receivedAtMs: Date.now() };
      result = await this.responder.respond(
        { texts, attachmentCount, history, turnKey: { generation: 0, turn: key.turn }, receivedAtMs: key.receivedAtMs },
        {
          onHeadsUp: async (raw) => {
            if (crisis) return;
            const checked = await stripBlockedLinks(guard(raw), checker);
            removed += checked.removed;
            headsUp = checked.text;
            headsUpAt = performance.now();
          },
        },
      );
    } catch (err) {
      // A heads-up already went out before the call failed; it was sent, so
      // it is still checked.
      if (err instanceof ResponderFailed) throw new TurnFailed(err.reason, err.attempts, headsUp === null ? [] : [headsUp]);
      throw err;
    }
    const totalMs = performance.now() - started;

    // The bench has no message to react to, so a tapback-only reply takes
    // the worker's text fallback, as it does when a tapback cannot be sent.
    const tapback = allowedTapback(result.tapback ?? null, turnText, crisis);
    let reply = result.text;
    // As the worker does: a question always gets words.
    if (!reply.trim()) reply = crisis ? "" : needsAnswer(turnText) ? NEEDS_ANSWER_TEXT : tapback ? tapbackText(tapback) : result.tapback ? refusedReactionText(turnText) : reply;
    const final = await finalizeReply(reply, { modelIds, crisis, checker, crisisLine: crisisLineFor(turnText) });
    removed += final.removed;
    changes.push(...final.changes);

    return {
      servedBy: this.responder.name !== "agent" ? "plain" : result.model === "agent" ? "agent" : "fallback",
      route: headsUp === null ? "fast" : "deep",
      headsUp,
      bubbles: final.bubbles,
      firstTextMs: headsUpAt === null ? totalMs : headsUpAt - started,
      totalMs,
      guardChanges: [...new Set(changes)],
      linksRemoved: removed,
      attempts: result.attempts,
      billedInputChars: result.inputChars * result.attempts,
      outputChars: result.outputChars,
    };
  }
}

// The responder gave up after its own retries. The reason is a safe machine
// string (an HTTP or run status), never provider text.
export class TurnFailed extends Error {
  readonly reason: string;
  readonly attempts: number;
  // Texts the person was already sent before the failure.
  readonly sent: string[];
  constructor(reason: string, attempts: number, sent: string[] = []) {
    super(`text line failed: ${reason}`);
    this.name = "TurnFailed";
    this.reason = reason;
    this.attempts = attempts;
    this.sent = sent;
  }
}

// Runs a conversation turn by turn, feeding the real replies back as
// history, the way the worker builds it. A turn whose call fails is retried
// once, alone, after a pause: same turn key, same receive time, same
// history, the way Channels recovers a turn. Completed turns are never sent
// again. Texts a failed try already sent are kept for the safety checks.
export async function converse(line: TextLine, turns: string[], attachmentCount = 0, retryDelayMs = 0): Promise<{ runs: TurnRun[]; sentByFailedTries: string[] }> {
  const history: HistoryMessage[] = [];
  const runs: TurnRun[] = [];
  const sentByFailedTries: string[] = [];
  for (const [i, text] of turns.entries()) {
    const at = { turn: i + 1, receivedAtMs: Date.now() };
    const attach = i === turns.length - 1 ? attachmentCount : 0;
    let run: TurnRun;
    try {
      run = await line.turn([text], [...history], attach, at);
    } catch (first) {
      if (!(first instanceof TurnFailed)) throw first;
      sentByFailedTries.push(...first.sent);
      // The responder already retried within a second; a burst of rate
      // limits outlasts that, so wait before the last try.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      try {
        run = await line.turn([text], [...history], attach, at);
      } catch (second) {
        if (!(second instanceof TurnFailed)) throw second;
        throw new TurnFailed(second.reason, second.attempts, [...sentByFailedTries, ...second.sent]);
      }
    }
    runs.push(run);
    history.push({ role: "person", text });
    history.push({ role: "mano", text: run.bubbles.join(" ") });
  }
  return { runs, sentByFailedTries };
}

export function textLineFromEnv(env: NodeJS.ProcessEnv = process.env): TextLine | null {
  const apiKey = env.META_MODEL_API_KEY ?? "";
  const model = env.MANO_MODEL_BENCH_ID ?? "";
  if (!apiKey || !model) return null;
  return new TextLine({ apiKey, model, ...(env.MANO_MODEL_BASE_URL ? { baseUrl: env.MANO_MODEL_BASE_URL } : {}) });
}

const CHARS_PER_TOKEN = 4;

// The text line as a bench answer path. Multi-turn cases are played turn by
// turn; the last turn's reply is the answer under test. A failed model call
// gets one more try, so a single transient error does not read as a
// regression; a second failure is an answer error, which gates.
export class TextLinePath implements AnswerPath {
  readonly name = "text-line";
  readonly live = true;
  readonly knowsCatalog = false;
  private line: TextLine;
  private retryDelayMs: number;

  constructor(line: TextLine, retryDelayMs = 15_000) {
    this.line = line;
    this.retryDelayMs = retryDelayMs;
  }

  async answer(c: BenchCase): Promise<BenchAnswer> {
    const { runs, sentByFailedTries } = await converse(this.line, c.input.turns, c.input.images?.length ?? 0, this.retryDelayMs);
    const last = runs[runs.length - 1]!;
    const billedInput = runs.reduce((sum, r) => sum + r.billedInputChars, 0);
    const output = runs.reduce((sum, r) => sum + r.outputChars, 0);
    return {
      text: last.bubbles.join("\n"),
      bubbles: last.bubbles,
      actions: [],
      latencyMs: Math.round(last.totalMs),
      firstTextMs: Math.round(last.firstTextMs),
      route: last.route,
      guardChanges: [...new Set(runs.flatMap((r) => r.guardChanges))],
      servedBy: combineServedBy(runs.map((r) => r.servedBy)),
      earlier: [...sentByFailedTries, ...runs.flatMap((r, i) => [...(r.headsUp ? [r.headsUp] : []), ...(i < runs.length - 1 ? r.bubbles : [])])],
      inputTokens: Math.round(billedInput / CHARS_PER_TOKEN),
      outputTokens: Math.round(output / CHARS_PER_TOKEN),
    };
  }
}
