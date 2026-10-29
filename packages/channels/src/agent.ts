// The agent behind the Responder interface. Calls Mano's agent over
// its synchronous turn route and falls back to the plain model answer
// on timeout or failure, so a text always gets an answer. Also
// verifies agent-started deliveries on the internal route. Both
// directions sign HMAC-SHA256 over "<timestamp>.<raw body>" with the
// one shared secret, the same construction as the provider webhooks.
//
// Each turn body carries, inside the signed bytes, a turn ID that stays
// the same across retries and recovery of that turn (handle, deletion
// generation, turn number), the generation itself, and a handle grant
// minted for this handle only. The agent forwards the grant to the
// engine with its own token; it never holds the grant secret.
import { guardReply } from "@mano/persona";
import { mintHandleGrant, personIdForHandle } from "@mano/protocol";

import { boundFetch } from "./fetch.js";
import { ResponderFailed, type Responder, type ResponderResult, type TurnInput } from "./responder.js";
import { splitBubbles } from "./bubbles.js";
import { computeSignatureHex, SIGNATURE_WINDOW_SECONDS, timingSafeEqualHex } from "./verify.js";

export const AGENT_TURN_PATH = "/channels/mano/turn";
export const AGENT_DELETED_PATH = "/channels/mano/deleted";
export const AGENT_PRESENTED_PATH = "/channels/mano/presented";
export const AGENT_SIGNATURE_HEADER = "x-mano-signature";
export const AGENT_TIMESTAMP_HEADER = "x-mano-timestamp";
// Above the agent's own settle timeout, so a slow turn falls back
// instead of hanging the conversation.
export const AGENT_RESPONDER_TIMEOUT_MS = 100_000;

// Sent instead of an approval question that would not reach the person
// word for word. It asks for nothing, so no YES can follow it.
export const APPROVAL_REFUSED_TEXT =
  "I prepared that request, but I could not show it to you exactly here, so I am not asking you to approve it and nothing was sent. Please do not reply YES to it.";

// The text line sends the question exactly when the voice guard leaves
// it unchanged and it holds no link the link check could strip. The
// agent runs the same check before it asks; this one also catches a
// reply whose text dropped or changed the question on the way.
export function approvalSurvivesTextLine(text: string, approval: unknown): boolean {
  if (typeof approval !== "string" || !approval || !text.includes(approval)) return false;
  return guardReply(approval).text === approval && !/https?:\/\/|www\./i.test(approval);
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

// SHA-256 (hex) of the question with whitespace runs collapsed, since
// bubble splitting breaks at spaces. The agent computes the same hash
// (apps/agent lib/pending.ts presentationHash); both pin one vector.
export async function presentationHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(collapse(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  grantSecret: string;
  handleHash: string;
  fallback: Responder;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  nowSeconds?: () => number;
}

interface AgentTurnResponse {
  status?: unknown;
  text?: unknown;
  approval?: unknown;
  approvalId?: unknown;
}

export class AgentResponder implements Responder {
  readonly name = "agent";
  readonly maxAttempts: number;
  private agentUrl: string;
  private secret: string;
  private grantSecret: string;
  private handleHash: string;
  private fallback: Responder;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private nowSeconds: () => number;

  constructor(opts: AgentResponderOptions) {
    if (!opts.agentUrl) throw new Error("An agent URL is required.");
    if (!opts.secret) throw new Error("An agent secret is required.");
    if (!opts.grantSecret) throw new Error("A handle grant secret is required.");
    if (!opts.handleHash) throw new Error("A handle hash is required.");
    this.agentUrl = opts.agentUrl.replace(/\/$/, "");
    this.secret = opts.secret;
    this.grantSecret = opts.grantSecret;
    this.handleHash = opts.handleHash;
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs ?? AGENT_RESPONDER_TIMEOUT_MS;
    this.maxAttempts = 1 + opts.fallback.maxAttempts;
    this.fetchFn = opts.fetchFn ?? boundFetch;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async respond(turn: TurnInput): Promise<ResponderResult> {
    const inputChars = turn.texts.join("\n").length;
    // Without a stable key the agent could run the turn twice, so it is
    // not called at all.
    if (!turn.turnKey) return this.respondFallback(turn, inputChars);
    try {
      const { generation, turn: number } = turn.turnKey;
      const raw = JSON.stringify({
        turnId: `${this.handleHash}:${generation}:${number}`,
        generation,
        handleHash: this.handleHash,
        grant: await mintHandleGrant(this.handleHash, this.grantSecret),
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
      if (res.ok && data?.status === "waiting_approval" && text && !approvalSurvivesTextLine(text, data.approval)) {
        return {
          text: APPROVAL_REFUSED_TEXT,
          bubbles: splitBubbles(APPROVAL_REFUSED_TEXT),
          inputChars,
          outputChars: APPROVAL_REFUSED_TEXT.length,
          model: "agent",
          attempts: 1,
        };
      }
      if (res.ok && (data?.status === "replied" || data?.status === "waiting_approval") && text) {
        const result: ResponderResult = {
          text,
          bubbles: splitBubbles(text),
          inputChars,
          outputChars: text.length,
          model: "agent",
          attempts: 1,
        };
        if (data.status === "waiting_approval" && typeof data.approvalId === "string" && typeof data.approval === "string") {
          const approvalId = data.approvalId;
          const approval = data.approval;
          result.afterSent = (sent) => this.reportPresented(approvalId, approval, generation, sent);
        }
        return result;
      }
    } catch {
      // Timeout, network, or malformed reply: fall through to the fallback.
    }
    return this.respondFallback(turn, inputChars);
  }

  // Tells the agent the question reached the person word for word, so a
  // YES to it can count. Only bubbles the provider accepted count, and
  // the question must appear in them whole (whitespace aside). Anything
  // less reports nothing, and the agent will not accept a YES.
  private async reportPresented(approvalId: string, approval: string, generation: number, sentTexts: string[]): Promise<void> {
    if (!collapse(sentTexts.join(" ")).includes(collapse(approval))) return;
    const raw = JSON.stringify({
      handleHash: this.handleHash,
      approvalId,
      textHash: await presentationHash(approval),
      generation,
      grant: await mintHandleGrant(this.handleHash, this.grantSecret),
    });
    const timestamp = this.nowSeconds();
    const res = await this.fetchFn(`${this.agentUrl}${AGENT_PRESENTED_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        "content-type": "application/json",
        [AGENT_TIMESTAMP_HEADER]: String(timestamp),
        [AGENT_SIGNATURE_HEADER]: await signAgentRequest(this.secret, timestamp, new TextEncoder().encode(raw)),
      },
      body: raw,
    });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`Agent refused the presented report: ${res.status}`);
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

export interface AgentDeletedNotice {
  agentUrl: string;
  secret: string;
  grantSecret: string;
  handleHash: string;
  // The generation after the wipe.
  generation: number;
  fetchFn?: typeof fetch;
  nowSeconds?: number;
}

// Tells the agent a conversation was deleted, so it closes the waiting
// approval in Engine, cancels the handle's reminders, deletes its Engine
// memory and retires its session. Signed like a turn, with a grant for
// the handle. Returns whether the agent confirmed; the caller logs a
// failure, and the generation checks on both sides still stop anything
// from before the deletion.
export async function notifyAgentDeleted(notice: AgentDeletedNotice): Promise<boolean> {
  const raw = JSON.stringify({
    handleHash: notice.handleHash,
    generation: notice.generation,
    grant: await mintHandleGrant(notice.handleHash, notice.grantSecret),
  });
  const timestamp = notice.nowSeconds ?? Math.floor(Date.now() / 1000);
  const res = await (notice.fetchFn ?? boundFetch)(`${notice.agentUrl.replace(/\/$/, "")}${AGENT_DELETED_PATH}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      [AGENT_TIMESTAMP_HEADER]: String(timestamp),
      [AGENT_SIGNATURE_HEADER]: await signAgentRequest(notice.secret, timestamp, new TextEncoder().encode(raw)),
    },
    body: raw,
  });
  await res.body?.cancel().catch(() => undefined);
  return res.ok;
}

export interface EngineConversationDelete {
  engineUrl: string;
  channelsToken: string;
  grantSecret: string;
  handleHash: string;
  fetchFn?: typeof fetch;
}

// Asks Engine to remove everything this person's agent kept for the
// conversation (reminders, turn ledger, approval pointer, pending
// approvals, memory) in one transaction. Channels' own token opens only
// this route, and only with a grant for this handle. Returns Engine's
// counts, or null when Engine did not confirm.
export async function deleteConversationInEngine(
  req: EngineConversationDelete,
): Promise<Record<string, number | boolean> | null> {
  const personId = personIdForHandle(req.handleHash);
  const res = await (req.fetchFn ?? boundFetch)(
    `${req.engineUrl.replace(/\/$/, "")}/api/persons/${encodeURIComponent(personId)}/conversation`,
    {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${req.channelsToken}`,
        "x-mano-handle-grant": await mintHandleGrant(req.handleHash, req.grantSecret),
      },
    },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = (await res.json().catch(() => null)) as { removed?: Record<string, number | boolean> } | null;
  return body?.removed ?? null;
}
