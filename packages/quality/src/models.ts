// Model client. Production uses Meta endpoints through config; without a key
// the fake client answers deterministically and the report says so. Real
// resident content only ever goes to Standard model IDs with store disabled.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelClient {
  id: string;
  live: boolean;
  complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<ChatResult>;
}

interface ChatCompletionsBody {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class MetaModelClient implements ModelClient {
  readonly live = true;
  readonly id: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(modelId: string, baseUrl: string, apiKey: string) {
    this.id = modelId;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.id, messages, store: false, max_tokens: opts?.maxTokens ?? 1024 }),
    });
    if (!res.ok) throw new Error(`model call failed: ${res.status}`);
    const body = (await res.json()) as ChatCompletionsBody;
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

// Deterministic stand-in. The handler decides the reply from the prompt so
// tests control exactly what the fake model says.
export class FakeModelClient implements ModelClient {
  readonly live = false;
  readonly id = "fake-model-client";
  private handler: (messages: ChatMessage[]) => string;

  constructor(handler?: (messages: ChatMessage[]) => string) {
    this.handler = handler ?? (() => "{}");
  }

  async complete(messages: ChatMessage[]): Promise<ChatResult> {
    const text = this.handler(messages);
    return { text, inputTokens: 10, outputTokens: 10 };
  }
}

export function judgeClientFromEnv(env: NodeJS.ProcessEnv = process.env): ModelClient {
  const key = env.MANO_MODEL_API_KEY ?? "";
  const base = env.MANO_MODEL_BASE_URL ?? "";
  const id = env.MANO_MODEL_JUDGE_ID ?? "muse-spark-1.3";
  if (key && base) return new MetaModelClient(id, base, key);
  return new FakeModelClient();
}

// Counts only rough tokens for cost math when the API reports none.
export function roughTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
