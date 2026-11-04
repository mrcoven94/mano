// The model behind the crisis check: one question, asked only when the
// keyword floor says crisis and the message is one short health question
// (decideCrisis in @mano/persona). Real resident text, so a Standard Meta
// model ID only, with store: false, through the same Responses API and AI
// Gateway as the replies (AGENTS.md rule 7). A -contributor ID is refused.
// With an open-weight fallback, the check asks it when the primary is down
// or the reply path's breaker is skipping the primary, so a crisis check
// never depends on the Meta Model API alone. It never logs the message.
import { CRISIS_CHECK_INSTRUCTIONS, crisisCheckInput, type CrisisCheck } from "@mano/persona";
import { boundFetch } from "./fetch.js";
import { primaryDownStatus, type OpenWeightFallback } from "./open-weight.js";

const CONTRIBUTOR_MODEL_RE = /-contributor$/i;
const TRAILING_SLASH_RE = /\/$/;

// A primary request that failed: down (402, 5xx, no connection) means
// the fallback may answer instead.
class CheckFailed extends Error {
  readonly down: boolean;
  constructor(message: string, down: boolean) {
    super(message);
    this.down = down;
  }
}

export interface ModelCrisisCheckOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  // False sends cf-aig-collect-log: false, so AI Gateway keeps no copy.
  collectLogs?: boolean;
  // When the second, identical request goes out.
  hedgeAfterMs?: number;
  // Shares the reply path's breaker. Only the reply path trips it: one
  // failed check inside a 3 second budget is too little evidence.
  openWeight?: OpenWeightFallback;
}

export class ModelCrisisCheck implements CrisisCheck {
  readonly live = true;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private collectLogs: boolean;
  private hedgeAfterMs: number;
  private openWeight?: OpenWeightFallback;

  constructor(opts: ModelCrisisCheckOptions) {
    if (!opts.apiKey) throw new Error("A model API key is required.");
    if (!opts.model || CONTRIBUTOR_MODEL_RE.test(opts.model)) throw new Error("The crisis check runs on a Standard model ID only.");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.meta.ai/v1").replace(TRAILING_SLASH_RE, "");
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.collectLogs = opts.collectLogs ?? true;
    this.hedgeAfterMs = opts.hedgeAfterMs ?? 700;
    this.openWeight = opts.openWeight;
  }

  // The answer has 3 seconds (CRISIS_CHECK_TIMEOUT_MS). The model sometimes takes
  // longer or returns nothing, so a second identical request goes out
  // after hedgeAfterMs; the first non-empty answer wins and the other is
  // cancelled. An empty answer is not an answer. Anything but a clean
  // "no" comes back as "yes", so it decides at once, as a crisis. When
  // the primary is down the fallback gets what is left of the 3 seconds.
  async ask(text: string, signal: AbortSignal): Promise<string> {
    const openWeight = this.openWeight;
    if (openWeight?.breaker.skipPrimary()) return this.askOpenWeight(openWeight, text, signal);
    try {
      return await this.askPrimary(text, signal);
    } catch (err) {
      if (!openWeight || !(err instanceof CheckFailed && err.down) || signal.aborted) throw err;
      return this.askOpenWeight(openWeight, text, signal);
    }
  }

  private async askPrimary(text: string, signal: AbortSignal): Promise<string> {
    const controllers = [new AbortController(), new AbortController()];
    const cancelAll = () => controllers.forEach((c) => c.abort());
    signal.addEventListener("abort", cancelAll, { once: true });
    const once = async (c: AbortController): Promise<string> => {
      const answer = (await this.request(text, AbortSignal.any([signal, c.signal]))).trim();
      if (!answer) throw new Error("crisis check returned no text");
      return answer;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let skipHedge: (err: unknown) => void = () => {};
    const hedged = new Promise<string>((resolve, reject) => {
      skipHedge = reject;
      timer = setTimeout(() => once(controllers[1]!).then(resolve, reject), this.hedgeAfterMs);
    });
    // A primary that is down will not answer the hedge either: fail at
    // once, so the fallback has the time.
    const first = once(controllers[0]!).catch((err: unknown) => {
      if (this.openWeight && err instanceof CheckFailed && err.down) {
        clearTimeout(timer);
        skipHedge(err);
      }
      throw err;
    });
    try {
      return await Promise.any([first, hedged]);
    } catch (err) {
      if (!(err instanceof AggregateError)) throw err;
      throw err.errors.find((e) => e instanceof CheckFailed && e.down) ?? err.errors[0] ?? err;
    } finally {
      clearTimeout(timer);
      cancelAll();
      signal.removeEventListener("abort", cancelAll);
    }
  }

  // The same question and the same rule: only a complete answer that is
  // exactly "no" exempts.
  private async askOpenWeight(openWeight: OpenWeightFallback, text: string, signal: AbortSignal): Promise<string> {
    const answer = await openWeight.client.ask(
      { instructions: CRISIS_CHECK_INSTRUCTIONS, input: [{ role: "user", content: crisisCheckInput(text) }], maxTokens: 512, effort: "minimal" },
      signal,
    );
    if (!answer.complete) return "yes";
    if (answer.text === "") throw new Error("crisis check returned no text");
    return answer.text === "no" ? "no" : "yes";
  }

  private async request(text: string, signal: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
    if (!this.collectLogs) headers["cf-aig-collect-log"] = "false";
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/responses`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({
          model: this.model,
          instructions: CRISIS_CHECK_INSTRUCTIONS,
          input: [{ role: "user", content: crisisCheckInput(text) }],
          store: false,
          // Room for the model's reasoning tokens; a small cap returns no text.
          max_output_tokens: 512,
          reasoning: { effort: "minimal" },
        }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new CheckFailed("crisis check could not connect", true);
    }
    if (!res.ok) throw new CheckFailed(`crisis check failed: ${res.status}`, primaryDownStatus(res.status));
    // A connection lost while the body streams in is a failed connection,
    // as in the reply path. A whole body that is not JSON is "yes".
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      if (signal.aborted) throw err;
      throw new CheckFailed("crisis check was cut off", true);
    }
    try {
      return classifierAnswer(JSON.parse(raw));
    } catch {
      return "yes";
    }
  }
}

// Written for this check alone, not the general extractor (Sol's fourth
// review): "no" only for a completed response with exactly one assistant
// message item, itself completed (Sol's fifth review), holding exactly one
// output_text part that says "no".
// Reasoning items may sit beside it; text anywhere else never counts. An
// empty message is no answer (the hedge may still bring one); every other
// shape is "yes".
export function classifierAnswer(data: unknown): string {
  if (!isRecord(data) || data.status !== "completed" || !Array.isArray(data.output)) return "yes";
  const messages = data.output.filter((item) => isRecord(item) && item.type === "message");
  if (messages.length !== 1) return "yes";
  const message = messages[0] as Record<string, unknown>;
  if (message.status !== "completed" || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length !== 1) return "yes";
  const part = message.content[0];
  if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") return "yes";
  const text = part.text.trim();
  if (text === "") return "";
  return text === "no" ? "no" : "yes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
