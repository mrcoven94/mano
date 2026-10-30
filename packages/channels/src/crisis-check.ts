// The model behind the crisis check: one question, asked only when the
// keyword floor says crisis and the message is one short health question
// (decideCrisis in @mano/persona). Real resident text, so a Standard Meta
// model ID only, with store: false, through the same Responses API and AI
// Gateway as the replies (AGENTS.md rule 7). A -contributor ID is refused.
// It never logs the message.
import { CRISIS_CHECK_INSTRUCTIONS, type CrisisCheck } from "@mano/persona";
import { boundFetch } from "./fetch.js";
import { extractOutputText } from "./responder.js";

export interface ModelCrisisCheckOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  // False sends cf-aig-collect-log: false, so AI Gateway keeps no copy.
  collectLogs?: boolean;
  // When the second, identical request goes out.
  hedgeAfterMs?: number;
}

export class ModelCrisisCheck implements CrisisCheck {
  readonly live = true;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private collectLogs: boolean;
  private hedgeAfterMs: number;

  constructor(opts: ModelCrisisCheckOptions) {
    if (!opts.apiKey) throw new Error("A model API key is required.");
    if (!opts.model || /-contributor$/i.test(opts.model)) throw new Error("The crisis check runs on a Standard model ID only.");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.collectLogs = opts.collectLogs ?? true;
    this.hedgeAfterMs = opts.hedgeAfterMs ?? 700;
  }

  // The answer has 2 seconds (decideCrisis). The model sometimes takes
  // longer or returns nothing, so a second identical request goes out
  // after hedgeAfterMs; the first non-empty answer wins and the other is
  // cancelled. An empty answer is not an answer.
  async ask(text: string, signal: AbortSignal): Promise<string> {
    const controllers = [new AbortController(), new AbortController()];
    const cancelAll = () => controllers.forEach((c) => c.abort());
    signal.addEventListener("abort", cancelAll, { once: true });
    const once = async (c: AbortController): Promise<string> => {
      const answer = (await this.request(text, AbortSignal.any([signal, c.signal]))).trim();
      if (!answer) throw new Error("crisis check returned no text");
      return answer;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hedged = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => once(controllers[1]!).then(resolve, reject), this.hedgeAfterMs);
    });
    try {
      return await Promise.any([once(controllers[0]!), hedged]);
    } catch (err) {
      throw err instanceof AggregateError ? (err.errors[0] ?? err) : err;
    } finally {
      clearTimeout(timer);
      cancelAll();
      signal.removeEventListener("abort", cancelAll);
    }
  }

  private async request(text: string, signal: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
    if (!this.collectLogs) headers["cf-aig-collect-log"] = "false";
    const res = await this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: this.model,
        instructions: CRISIS_CHECK_INSTRUCTIONS,
        input: [{ role: "user", content: text }],
        store: false,
        // Room for the model's reasoning tokens; a small cap returns no text.
        max_output_tokens: 512,
        reasoning: { effort: "minimal" },
      }),
    });
    if (!res.ok) throw new Error(`crisis check failed: ${res.status}`);
    return extractOutputText(await res.json());
  }
}
