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
  stripBlockedLinks,
  type HistoryMessage,
} from "@mano/channels";
import { REFUSED_TAPBACK_TEXT, allowedTapback, crisisLineFor, crisisTurn, guardReply, tapbackText, type GuardChange } from "@mano/persona";
import { viaAiGateway } from "./models.ts";
import type { AnswerPath, BenchAnswer } from "./paths.ts";
import type { BenchCase } from "./suites/types.ts";

export interface TurnRun {
  route: "fast" | "deep";
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

// Synthetic bench text may go to a -contributor ID; the judge never does.
export class TextLine {
  readonly model: string;
  private responder: SparkResponder;
  private fetchFn: typeof fetch | undefined;

  constructor(opts: TextLineOptions) {
    this.model = opts.model;
    this.fetchFn = opts.fetchFn;
    this.responder = new SparkResponder({
      apiKey: opts.apiKey,
      model: opts.model,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      // Through AI Gateway, no request or reply is logged.
      collectLogs: !viaAiGateway(opts.baseUrl ?? ""),
    });
  }

  async turn(texts: string[], history: HistoryMessage[], attachmentCount = 0): Promise<TurnRun> {
    // The worker answers STOP and its kin itself, before any model call.
    if (texts.length === 1 && attachmentCount === 0 && isOptOut(texts[0]!)) {
      return { route: "fast", headsUp: null, bubbles: [OPT_OUT_BUBBLE], firstTextMs: 0, totalMs: 0, guardChanges: [], linksRemoved: 0, attempts: 0, billedInputChars: 0, outputChars: 0 };
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
      result = await this.responder.respond(
        { texts, attachmentCount, history },
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
      if (err instanceof ResponderFailed) throw new TurnFailed(err.reason, err.attempts);
      throw err;
    }
    const totalMs = performance.now() - started;

    // The bench has no message to react to, so a tapback-only reply takes
    // the worker's text fallback, as it does when a tapback cannot be sent.
    const tapback = allowedTapback(result.tapback ?? null, turnText, crisis);
    let reply = result.text;
    if (!reply.trim()) reply = crisis ? "" : tapback ? tapbackText(tapback) : result.tapback ? REFUSED_TAPBACK_TEXT : reply;
    const final = await finalizeReply(reply, { modelIds, crisis, checker, crisisLine: crisisLineFor(turnText) });
    removed += final.removed;
    changes.push(...final.changes);

    return {
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
  constructor(reason: string, attempts: number) {
    super(`text line failed: ${reason}`);
    this.name = "TurnFailed";
    this.reason = reason;
    this.attempts = attempts;
  }
}

// Runs a conversation turn by turn, feeding the real replies back as
// history, the way the worker builds it.
export async function converse(line: TextLine, turns: string[], attachmentCount = 0): Promise<TurnRun[]> {
  const history: HistoryMessage[] = [];
  const runs: TurnRun[] = [];
  for (const [i, text] of turns.entries()) {
    const run = await line.turn([text], [...history], i === turns.length - 1 ? attachmentCount : 0);
    runs.push(run);
    history.push({ role: "person", text });
    history.push({ role: "mano", text: run.bubbles.join(" ") });
  }
  return runs;
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
    let runs: TurnRun[];
    try {
      runs = await converse(this.line, c.input.turns, c.input.images?.length ?? 0);
    } catch (err) {
      if (!(err instanceof TurnFailed)) throw err;
      // The responder already retried within a second; a burst of rate
      // limits outlasts that, so wait before the last try.
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      runs = await converse(this.line, c.input.turns, c.input.images?.length ?? 0);
    }
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
      earlier: runs.flatMap((r, i) => [...(r.headsUp ? [r.headsUp] : []), ...(i < runs.length - 1 ? r.bubbles : [])]),
      inputTokens: Math.round(billedInput / CHARS_PER_TOKEN),
      outputTokens: Math.round(output / CHARS_PER_TOKEN),
    };
  }
}
