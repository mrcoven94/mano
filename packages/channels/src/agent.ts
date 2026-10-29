// The agent behind the Responder interface. Calls Mano's agent over
// its synchronous turn route and falls back to the plain model answer
// on timeout or failure, so a text always gets an answer. Also
// verifies agent-started deliveries on the internal route. Both
// directions sign HMAC-SHA256 over "<timestamp>.<raw body>" with the
// one shared secret, the same construction as the provider webhooks.
import { boundFetch } from "./fetch.js";
import { ResponderFailed, type Responder, type ResponderResult, type TurnInput } from "./responder.js";
import { splitBubbles } from "./bubbles.js";
import { computeSignatureHex, SIGNATURE_WINDOW_SECONDS, timingSafeEqualHex } from "./verify.js";

export const AGENT_TURN_PATH = "/channels/mano/turn";
export const AGENT_SIGNATURE_HEADER = "x-mano-signature";
export const AGENT_TIMESTAMP_HEADER = "x-mano-timestamp";
// Above the agent's own settle timeout, so a slow turn falls back
// instead of hanging the conversation.
export const AGENT_RESPONDER_TIMEOUT_MS = 100_000;

export type AgentVerifyFailure = "missing" | "bad_timestamp" | "stale" | "bad_signature";

export async function verifyAgentRequest(
  secret: string | undefined,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: Uint8Array,
  nowSeconds: number,
): Promise<{ ok: boolean; reason?: AgentVerifyFailure }> {
  if (!secret || !timestampHeader || !signatureHeader) return { ok: false, reason: "missing" };
  if (!/^[0-9]+$/.test(timestampHeader)) return { ok: false, reason: "bad_timestamp" };
  const age = nowSeconds - Number(timestampHeader);
  if (Math.abs(age) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: "stale" };
  const expected = await computeSignatureHex(secret, timestampHeader, rawBody);
  if (!timingSafeEqualHex(signatureHeader.toLowerCase(), expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

export async function signAgentRequest(secret: string, timestampSeconds: number, rawBody: Uint8Array): Promise<string> {
  return computeSignatureHex(secret, String(timestampSeconds), rawBody);
}

export interface AgentResponderOptions {
  agentUrl: string;
  secret: string;
  handleHash: string;
  fallback: Responder;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  nowSeconds?: () => number;
}

interface AgentTurnResponse {
  status?: unknown;
  text?: unknown;
}

export class AgentResponder implements Responder {
  readonly name = "agent";
  readonly maxAttempts: number;
  private agentUrl: string;
  private secret: string;
  private handleHash: string;
  private fallback: Responder;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private nowSeconds: () => number;

  constructor(opts: AgentResponderOptions) {
    if (!opts.agentUrl) throw new Error("An agent URL is required.");
    if (!opts.secret) throw new Error("An agent secret is required.");
    if (!opts.handleHash) throw new Error("A handle hash is required.");
    this.agentUrl = opts.agentUrl.replace(/\/$/, "");
    this.secret = opts.secret;
    this.handleHash = opts.handleHash;
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs ?? AGENT_RESPONDER_TIMEOUT_MS;
    this.maxAttempts = 1 + opts.fallback.maxAttempts;
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async respond(turn: TurnInput): Promise<ResponderResult> {
    const inputChars = turn.texts.join("\n").length;
    try {
      const raw = JSON.stringify({
        handleHash: this.handleHash,
        texts: turn.texts,
        attachmentCount: turn.attachmentCount,
      });
      const timestamp = this.nowSeconds();
      const res = await this.fetchFn(`${this.agentUrl}${AGENT_TURN_PATH}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "content-type": "application/json",
          [AGENT_TIMESTAMP_HEADER]: String(timestamp),
          [AGENT_SIGNATURE_HEADER]: await signAgentRequest(this.secret, timestamp, new TextEncoder().encode(raw)),
        },
        body: raw,
      });
      const data = (await res.json().catch(() => null)) as AgentTurnResponse | null;
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (res.ok && (data?.status === "replied" || data?.status === "waiting_input") && text) {
        return {
          text,
          bubbles: splitBubbles(text),
          inputChars,
          outputChars: text.length,
          model: "agent",
          attempts: 1,
        };
      }
    } catch {
      // Timeout, network, or malformed reply: fall through to the fallback.
    }
    return this.respondFallback(turn, inputChars);
  }

  private async respondFallback(turn: TurnInput, inputChars: number): Promise<ResponderResult> {
    try {
      const result = await this.fallback.respond(turn);
      return { ...result, attempts: 1 + result.attempts };
    } catch (err) {
      if (err instanceof ResponderFailed) {
        throw new ResponderFailed(err.message, 1 + err.attempts, inputChars, err.reason);
      }
      if (err instanceof Error) throw new ResponderFailed(err.message, this.maxAttempts, inputChars);
      throw new ResponderFailed("Agent and fallback failed.", this.maxAttempts, inputChars);
    }
  }
}
