export interface ModelRequest {
  input: string;
  synthetic: boolean;
  model?: string;
}

export interface CostEntry {
  model: string;
  synthetic: boolean;
  at: string;
  inputChars: number;
}

export class MetaModelClient {
  costLog: CostEntry[] = [];
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string;
    gatewayBase?: string;
    timeoutMs?: number;
    maxRetries?: number;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.gatewayBase ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  resolveModel(synthetic: boolean, requested?: string): string {
    if (requested) {
      if (!synthetic && requested.includes("-contributor")) {
        throw new Error("Contributor models are only allowed for synthetic data.");
      }
      return requested;
    }
    return synthetic ? "muse-spark-1.3-contributor" : "muse-spark-1.3";
  }

  async complete(req: ModelRequest): Promise<{ text: string; model: string }> {
    const model = this.resolveModel(req.synthetic, req.model);
    this.costLog.push({ model, synthetic: req.synthetic, at: new Date().toISOString(), inputChars: req.input.length });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`${this.baseUrl}/responses`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, input: req.input, store: false }),
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Model request failed: ${res.status}`);
        const data = (await res.json()) as { output_text?: string };
        return { text: data.output_text ?? "", model };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Model request failed.");
  }
}
