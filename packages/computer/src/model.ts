/** Smallest Responses API surface the loop needs. Raw JSON in and out. */

export interface ResponseRequest {
  model: string;
  instructions: string;
  tools: Array<{ type: string }>;
  input: unknown[];
  store: boolean;
}

export interface ResponsePayload {
  id: string;
  status: string;
  output: unknown[];
}

export interface ModelClient {
  createResponse(request: ResponseRequest): Promise<ResponsePayload>;
}

export interface FetchModelOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Backoff between transient retries. Defaults to 1s, 2s, 4s. */
  retryDelaysMs?: number[];
}

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

/** Responses API over fetch. Sends store:false so nothing is kept server-side. */
export class FetchModelClient implements ModelClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private retryDelaysMs: number[];

  constructor(options: FetchModelOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 4000];
  }

  async createResponse(request: ResponseRequest): Promise<ResponsePayload> {
    const body = JSON.stringify({ model: request.model, instructions: request.instructions, tools: request.tools, input: request.input, store: request.store });
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body,
        });
      } catch (err) {
        if (!(await this.backoff(attempt++))) throw err;
        continue;
      }
      if (res.ok) {
        const payload = (await res.json()) as { id?: unknown; status?: unknown; output?: unknown };
        if (typeof payload.id !== "string" || !Array.isArray(payload.output)) throw new Error("model returned a malformed response");
        return { id: payload.id, status: typeof payload.status === "string" ? payload.status : "unknown", output: payload.output };
      }
      const detail = await res.text().catch(() => "");
      if (!RETRYABLE_STATUSES.has(res.status) || !(await this.backoff(attempt++))) {
        throw new Error(`model request failed with status ${res.status}: ${detail.slice(0, 500)}`);
      }
    }
  }

  private async backoff(attempt: number): Promise<boolean> {
    const wait = this.retryDelaysMs[attempt];
    if (wait === undefined) return false;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return true;
  }
}

/** A scripted model for tests. Each turn pops the next queued output list. */
export class FakeModelClient implements ModelClient {
  readonly requests: ResponseRequest[] = [];
  private queued: unknown[][];

  constructor(outputs: unknown[][] = []) {
    this.queued = outputs.map((o) => [...o]);
  }

  queue(output: unknown[]): void {
    this.queued.push([...output]);
  }

  async createResponse(request: ResponseRequest): Promise<ResponsePayload> {
    this.requests.push(request);
    const output = this.queued.shift();
    if (!output) throw new Error("fake model ran out of queued outputs");
    return { id: `resp-${this.requests.length}`, status: "completed", output };
  }
}
